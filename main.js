// earbud-speaker 电子脑
// 职责: 与 Node worker 的 JSON-RPC 通信 + 对话触发(errand 派活 / oneshot 快问快答)
//       + 状态广播给面板 + 精简播报提示词编排
cindy.onHostMessage(async function (msg) {
  // ---------------- worker 反向通知 ----------------
  if (msg.type === 'event' && msg.name === 'node-notification') {
    const p = msg.params || {};
    if (msg.method === 'state') {
      broadcast({ type: 'state', phase: p.phase, listening: p.listening });
      await saveKv({ lastPhase: p.phase, listening: p.listening });
    } else if (msg.method === 'utterance') {
      // 语音输入完成 → 触发对话
      handleUtterance(p.text).catch((e) => log('对话处理失败: ' + (e && e.message)));
    } else if (msg.method === 'dl-progress') {
      broadcast({ type: 'dl-progress', key: p.key, pct: p.pct, name: p.name });
    } else if (msg.method === 'dl-done') {
      broadcast({ type: 'dl-done', ok: p.ok, message: p.message });
      if (!p.ok) {
        cindy.send({ type: 'notify', tone: 'error', text: '模型下载失败: ' + String(p.message || '').slice(0, 120) });
      } else {
        cindy.send({ type: 'notify', tone: 'success', text: '语音模型已就绪' });
      }
    } else if (msg.method === 'need-models') {
      broadcast({ type: 'need-models' });
    } else if (msg.method === 'log') {
      log(p.msg);
    }
    return;
  }
  if (msg.type === 'event' && msg.name === 'node-status') {
    broadcast({ type: 'node-status', state: msg.state });
    return;
  }

  if (msg.type !== 'tool-call') return;

  // ---------------- AI 工具 ----------------
  if (msg.tool === 'speaker_control') {
    const action = String(msg.args.action || 'status');
    try {
      if (action === 'start') {
        const r = await cindy.node.request({ method: 'start', params: {}, timeoutMs: 30000 });
        cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: r.result || r });
      } else if (action === 'stop') {
        const r = await cindy.node.request({ method: 'stop', params: {} });
        cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: r.result || r });
      } else if (action === 'status') {
        const r = await cindy.node.request({ method: 'status', params: {} });
        cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: r.result || r });
      } else if (action === 'ask') {
        // 直接用文字走一遍语音问答链路(识别→思考→播报)
        const text = String(msg.args.text || '').trim();
        if (!text) throw new Error('text 不能为空');
        await cindy.node.request({ method: 'utteranceDirect', params: { text } });
        cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: { accepted: true, text } });
      } else if (action === 'configure') {
        const r = await cindy.node.request({ method: 'configure', params: { config: msg.args.config || {} }, timeoutMs: 30000 });
        cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: r.result || r });
      } else if (action === 'download_models') {
        await cindy.node.request({ method: 'downloadModels', params: {} });
        cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: { started: true, note: '模型下载已在后台进行' } });
      } else {
        cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, errorCode: 'BAD_ACTION', message: 'action 只支持 start/stop/status/ask/configure/download_models' });
      }
    } catch (e) {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, errorCode: 'NODE_ERROR', message: String(e && e.message || e).slice(0, 300) + '。若提示模型未就绪,可让用户在插件面板点「下载语音模型」。' });
    }
    return;
  }

  cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, errorCode: 'UNKNOWN_TOOL', message: '未知工具: ' + msg.tool });
});

// ---------------- 对话触发 ----------------

async function loadKv() {
  try {
    const raw = await cindy.fs({ op: 'read', root: 'data', path: 'state.json' });
    return JSON.parse(raw.content || '{}');
  } catch { return {}; }
}
async function saveKv(patch) {
  try {
    const cur = await loadKv();
    const next = Object.assign({}, cur, patch);
    await cindy.fs({ op: 'write', root: 'data', path: 'state.json', content: JSON.stringify(next) });
  } catch { /* 忽略状态保存失败 */ }
}

function history() {
  const H = [];
  const push = (role, text) => {
    if (!text) return;
    H.push({ role, text: String(text).slice(0, 1200) });
    if (H.length > 8) H.shift();
  };
  return { push, asText() {
    return H.map((h) => (h.role === 'user' ? '问: ' : '答: ') + h.text).join('\n');
  } };
}
const hist = history();

const logLines = [];
function log(text) {
  logLines.push({ text: String(text).slice(0, 200), ts: Date.now() });
  if (logLines.length > 50) logLines.shift();
  try { console.log('[earbud-speaker]', text); } catch { /* */ }
}

const SPEAK_STYLE =
  '回答要求(将转为语音播报给蓝牙耳机听):口语化、自然、简洁,像智能音箱播报。' +
  '不要用 markdown、列表符号、编号符号或表情;不要念出链接和标点;' +
  '核心信息控制在 3~5 句话内说完;数字和时间用中文口语读法(如"下午三点");' +
  '结尾不用客套话。';

async function handleUtterance(text) {
  hist.push('user', text);
  const prefs = await loadKv();
  const fastMode = prefs.fastMode !== false; // 默认开快速通道
  broadcast({ type: 'thinking', text });

  let answer = '';
  let via = '';

  if (fastMode) {
    const prompt =
      SPEAK_STYLE + '\n\n' +
      (hist.asText() ? '对话上下文(仅参考):\n' + hist.asText() + '\n\n' : '') +
      '用户问题: ' + text;
    const r = await cindy.send({
      type: 'cindy-request', kind: 'oneshot_text',
      prompt, maxTokens: 512,
    });
    if (r && r.ok) {
      answer = String(r.text || '').trim();
      via = '快速通道';
    } else if (r && r.errorCode === 'NO_CANDIDATE') {
      log('快速通道不可用,转派活');
    } else if (r) {
      log('快速通道失败: ' + (r.message || ''), '转派活');
    }
  }

  if (!answer) {
    // errand 派活: 新会话、结果只取文字
    const r = await cindy.agent.errand({
      task:
        SPEAK_STYLE + '\n\n' +
        (hist.asText() ? '对话上下文(仅参考):\n' + hist.asText() + '\n\n' : '') +
        '请回答下面这个问题(可动用工具查资料,但最终回答要符合上面的播报要求):\n' + text,
      title: '耳机语音提问',
      sessionKey: 'voice-' + Date.now().toString(36),
      callId: undefined, // 语音触发的自主调用
    });
    if (!r.ok) {
      broadcast({ type: 'error', message: '派活失败: ' + (r.message || r.errorCode) });
      answer = '抱歉,我遇到了点问题,稍后再试。';
    } else {
      // 轮询取件
      answer = await pollErrand(r.jobId);
    }
  }

  hist.push('assistant', answer);
  broadcast({ type: 'answer', text: answer, via });

  // 播报
  const sp = await cindy.node.request({ method: 'speak', params: { text: answer }, timeoutMs: 120000, maxTotalMs: 600000 });
  if (!sp.ok) log('播报失败: ' + sp.message);
}

async function pollErrand(jobId) {
  const t0 = Date.now();
  const MAX = 25 * 60 * 1000; // 25 分钟
  while (Date.now() - t0 < MAX) {
    await sleep(5000);
    const q = await cindy.agent.queryErrand({ jobId });
    if (q.ok && q.status === 'done') return String(q.text || '').trim() || '我没有得到答案。';
    if (!q.ok) {
      log('取件失败: ' + (q.message || q.errorCode));
      return '抱歉,任务执行出错了。';
    }
  }
  return '这个问题处理时间比较长,结果稍后在会话里查看。';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- 面板广播 + worker 启动 ----------------

const CH_NAME = 'earbud-speaker';

function broadcast(data) {
  try {
    const ch = new BroadcastChannel(CH_NAME);
    ch.postMessage(data);
    ch.close();
  } catch { /* */ }
}

function log(text) {
  logLines.push({ text: String(text).slice(0, 200), ts: Date.now() });
  if (logLines.length > 50) logLines.shift();
  try { console.log('[earbud-speaker]', text); } catch { /* */ }
}

// 面板 → 电子脑动作通道(面板先 /wake 再广播)
const seenReq = new Set();
try {
  const chIn = new BroadcastChannel(CH_NAME);
  chIn.addEventListener('message', async (ev) => {
    const m = ev.data || {};
    if (m.type !== 'panel-action' || !m.reqId || seenReq.has(m.reqId)) return;
    seenReq.add(m.reqId);
    if (seenReq.size > 200) seenReq.clear();
    const reply = (payload) => {
      const ch = new BroadcastChannel(CH_NAME);
      ch.postMessage(Object.assign({ replyTo: m.reqId }, payload));
      ch.close();
    };
    try {
      if (m.action === 'start') {
        await saveKv({ autoStart: true });
        const r = await cindy.node.request({ method: 'start', params: {}, timeoutMs: 30000 });
        broadcast({ type: 'state', phase: r.result && r.result.phase || 'IDLE', listening: true });
      } else if (m.action === 'stop') {
        await saveKv({ autoStart: false });
        await cindy.node.request({ method: 'stop', params: {} });
        broadcast({ type: 'state', phase: 'STOPPED', listening: false });
      } else if (m.action === 'download_models') {
        await cindy.node.request({ method: 'downloadModels', params: {} });
      } else if (m.action === 'configure') {
        const prefs = await loadKv();
        await cindy.node.request({
          method: 'configure',
          params: { config: { wakeWords: prefs.wakeWords || ['嘿辛蒂'], volume: prefs.volume ?? 1.0 } },
          timeoutMs: 30000,
        });
      } else if (m.action === 'sync') {
        const r = await cindy.node.request({ method: 'status', params: {} });
        if (r.ok && r.result) {
          broadcast({ type: 'state', phase: r.result.phase, listening: r.result.listening });
          broadcast({ type: 'init', ready: r.result.modelsReady, modelsDir: r.result.modelsDir });
          if (r.result.lastUtterance) broadcast({ type: 'thinking', text: r.result.lastUtterance.text });
        }
      }
      reply({ type: 'ok' });
    } catch (e) {
      reply({ type: 'error', message: String(e && e.message || e).slice(0, 200) });
    }
  });
} catch { /* BroadcastChannel 不可用时忽略 */ }

(async () => {
  // 启动即拉起 worker(resident 模式下宿主已拉,这里做配置下发)
  try {
    const prefs = await loadKv();
    const r = await cindy.node.request({
      method: 'init',
      params: { config: { wakeWords: prefs.wakeWords || ['嘿辛蒂'], volume: prefs.volume ?? 1.0 } },
      timeoutMs: 30000,
    });
    if (r.ok && r.result) {
      broadcast({ type: 'init', ready: r.result.ready, modelsDir: r.result.modelsDir, phase: r.result.phase });
      if (prefs.autoStart && r.result.ready) {
        await cindy.node.request({ method: 'start', params: {}, timeoutMs: 30000 });
      }
    }
  } catch (e) {
    log('worker 初始化失败: ' + (e && e.message));
  }
})();
