// earbud-speaker 面板逻辑
const $ = (s) => document.querySelector(s);
const GHOST_ID = 'earbud-speaker';

const PHASE_TEXT = {
  UNINIT: ['未初始化', '等待插件启动'],
  STOPPED: ['已停止', '模型未就绪或被手动停止'],
  IDLE: ['待命中', '说唤醒词「嘿辛蒂」开始提问'],
  LISTENING: ['聆听中', '我在听你说…说完停顿一下'],
  THINKING: ['思考中', 'Cindy 正在组织答案'],
  SPEAKING: ['播报中', '正在通过耳机播放答案'],
  DOWNLOADING: ['下载模型', '首次使用需要下载语音模型(约 600MB)'],
};

const state = {
  phase: 'UNINIT',
  listening: false,
  ready: false,
};

// ---------- /kv 读写 ----------
async function readKv() {
  try { return await (await fetch('/kv')).json(); } catch { return {}; }
}
async function writeKv(patch) {
  const cur = await readKv();
  const next = Object.assign({}, cur, patch);
  await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
  return next;
}

// ---------- UI ----------
function setPhase(phase, listening) {
  state.phase = phase;
  if (listening !== undefined) state.listening = listening;
  const [title, desc] = PHASE_TEXT[phase] || [phase, ''];
  $('#phaseTitle').textContent = title;
  $('#phaseDesc').textContent = desc;
  $('#phaseDot').className = 'dot ' + phase;
  const btn = $('#btnToggle');
  btn.textContent = state.listening ? '停止聆听' : '开始聆听';
  btn.classList.toggle('off', state.listening);
}

function addLog(text) {
  const li = document.createElement('li');
  li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
  const list = $('#logList');
  list.prepend(li);
  while (list.children.length > 30) list.lastChild.remove();
}

function addQA(role, text) {
  const list = $('#qaList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.className = 'role ' + (role === 'user' ? 'user' : 'bot');
  span.textContent = role === 'user' ? '你:' : '辛蒂:';
  li.appendChild(span);
  li.appendChild(document.createTextNode(text));
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}

// ---------- 与电子脑通信 ----------
function wakeBrain() {
  return fetch('cindy-ghost://' + GHOST_ID + '/wake').catch(() => {});
}

function sendToBrain(data, onReply, timeoutMs = 3000) {
  let done = false;
  const ch = new BroadcastChannel(GHOST_ID);
  const reqId = 'r' + Math.random().toString(36).slice(2);
  const payload = Object.assign({ reqId }, data);
  const recv = (ev) => {
    if (ev.data && ev.data.replyTo === reqId) {
      done = true;
      ch.close();
      onReply && onReply(ev.data);
    }
  };
  ch.addEventListener('message', recv);
  const retry = setInterval(() => {
    if (done) { clearInterval(retry); return; }
    ch.postMessage(payload);
  }, 300);
  setTimeout(() => {
    clearInterval(retry);
    if (!done) { ch.close(); onReply && onReply({ type: 'timeout' }); }
  }, timeoutMs);
}

// 面板命令(经广播交给电子脑执行)
function requestAction(action) {
  wakeBrain().then(() => sendToBrain({ type: 'panel-action', action }));
}

// ---------- 事件绑定 ----------
$('#btnToggle').addEventListener('click', () => {
  requestAction(state.listening ? 'stop' : 'start');
});
$('#btnModels').addEventListener('click', () => {
  $('#dlSection').classList.remove('hidden');
  requestAction('download_models');
});
$('#fastMode').addEventListener('change', (e) => {
  writeKv({ fastMode: e.target.checked });
  requestAction('configure');
});

// ---------- 广播接收 ----------
const ch = new BroadcastChannel(GHOST_ID);
ch.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.replyTo) return; // 是给请求方的回执,不是广播
  switch (m.type) {
    case 'state':
      setPhase(m.phase, m.listening);
      addLog('状态 → ' + m.phase);
      break;
    case 'init':
      state.ready = m.ready;
      if (m.phase) setPhase(m.phase, m.phase !== 'STOPPED' && m.phase !== 'UNINIT' ? true : false);
      $('#btnModels').disabled = !!m.ready;
      if (!m.ready) $('#dlSection').classList.remove('hidden');
      break;
    case 'dl-progress':
      $('#dlSection').classList.remove('hidden');
      $('#dlName').textContent = m.name || '模型';
      $('#dlPct').textContent = m.pct + '%';
      $('#dlBar').style.width = m.pct + '%';
      break;
    case 'dl-done':
      if (m.ok) {
        $('#dlSection').classList.add('hidden');
        $('#btnModels').disabled = true;
        setPhase('STOPPED');
      }
      break;
    case 'need-models':
      $('#dlSection').classList.remove('hidden');
      break;
    case 'thinking':
      addQA('user', m.text);
      break;
    case 'answer':
      addQA('bot', m.text);
      break;
    case 'error':
      addLog('错误: ' + m.message);
      break;
  }
});

// ---------- 启动 ----------
(async () => {
  const kv = await readKv();
  $('#fastMode').checked = kv.fastMode !== false;
  await wakeBrain();
  // 拉取当前状态
  sendToBrain({ type: 'panel-action', action: 'sync' });
})();
