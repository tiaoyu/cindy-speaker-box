const $ = (s) => document.querySelector(s);
const GHOST_ID = 'earbud-speaker';
const SELECT_STYLE = 'background:var(--surface,#fff);color:inherit;border:1px solid var(--border-default,#e4e4e0);border-radius:6px;padding:6px 10px;width:100%';

function detectPlatform() {
  const plat = String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const ua = String(navigator.userAgent || '');
  if (/Mac/i.test(plat) || /Mac OS X/i.test(ua)) return 'darwin';
  if (/Win/i.test(plat) || /Windows/i.test(ua)) return 'win32';
  if (/Linux/i.test(plat) || /Linux/i.test(ua)) return 'linux';
  return '';
}

function defaultModelsDir(platform) {
  if (platform === 'win32') return '%LOCALAPPDATA%\\earbud-speaker\\models';
  if (platform === 'darwin' || platform === 'linux') return '~/earbud-speaker/models';
  return '';
}

function platformHints(platform) {
  if (platform === 'darwin') {
    return {
      sound: '可在上方选择麦克风和耳机。留空则使用系统默认设备。也可到系统设置 → 声音里确认这副蓝牙耳机已接上。',
      mic: '系统设置 → 隐私与安全性 → 麦克风：允许 Cindy。可先用「语音备忘录」确认耳机麦能录上音。',
    };
  }
  if (platform === 'linux') {
    return {
      sound: '可在上方选择麦克风和耳机。留空则使用系统默认设备。',
      mic: '在系统隐私 / 权限设置里允许 Cindy 使用麦克风。',
    };
  }
  return {
    sound: '可在上方选择麦克风和耳机。留空则使用系统默认设备。Windows 设备名最长 31 个字符（系统 API 限制），以列表里显示的名称为准。',
    mic: '设置 → 隐私和安全性 → 麦克风：允许 Cindy。',
  };
}

function applyPlatformHints(cfg) {
  const platform = cfg.platform || detectPlatform() || 'win32';
  const modelsDir = cfg.modelsDir || defaultModelsDir(platform);
  const hints = platformHints(platform);
  $('#modelsDir').textContent = modelsDir;
  $('#soundHint').textContent = hints.sound;
  $('#micHint').textContent = hints.mic;
}

function fillSelect(sel, devices, selected, defaultLabel) {
  const list = Array.isArray(devices) ? devices : [];
  const cur = selected == null ? '' : String(selected);
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = defaultLabel;
  sel.appendChild(opt0);
  const seen = new Set(['']);
  for (const d of list) {
    const id = String(d && d.id != null ? d.id : '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = String(d.name || id);
    sel.appendChild(opt);
  }
  if (cur && !seen.has(cur)) {
    const opt = document.createElement('option');
    opt.value = cur;
    opt.textContent = cur + '（当前已保存，列表中未找到）';
    sel.appendChild(opt);
  }
  sel.value = cur;
  sel.style.cssText = SELECT_STYLE;
}

function applyDevices(devices, cfg) {
  const inputs = (devices && devices.inputs) || (cfg.audioDevices && cfg.audioDevices.inputs) || [];
  const outputs = (devices && devices.outputs) || (cfg.audioDevices && cfg.audioDevices.outputs) || [];
  fillSelect($('#inputDevice'), inputs, cfg.inputDevice || '', '系统默认输入');
  fillSelect($('#outputDevice'), outputs, cfg.outputDevice || '', '系统默认输出');
  const err = devices && devices.error;
  if (err) {
    $('#deviceHint').textContent = '枚举设备失败: ' + err;
  } else if (!inputs.length && !outputs.length) {
    $('#deviceHint').textContent = '没有列出设备。可点「刷新设备」，或先连接耳机后再试。留空将使用系统默认。';
  } else {
    $('#deviceHint').textContent = '保存后立即用于录音和播报。插拔耳机后请再刷新一次。';
  }
}

function wakeBrain() {
  return fetch('cindy-ghost://' + GHOST_ID + '/wake').catch(() => {});
}

function sendToBrain(data, onReply, timeoutMs = 8000) {
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

function refreshDevices(cfg) {
  $('#deviceHint').textContent = '正在刷新设备列表…';
  return wakeBrain().then(() => new Promise((resolve) => {
    sendToBrain({ type: 'panel-action', action: 'list-devices' }, (reply) => {
      if (reply && reply.type === 'ok' && reply.devices) {
        applyDevices(reply.devices, cfg);
      } else if (reply && reply.type === 'timeout') {
        applyDevices(null, cfg);
        $('#deviceHint').textContent = '刷新超时，已显示上次缓存。请确认插件已启动后再试。';
      } else {
        applyDevices(null, cfg);
        $('#deviceHint').textContent = '刷新失败: ' + String((reply && reply.message) || '未知错误');
      }
      resolve();
    }, 12000);
  }));
}

let currentCfg = {};

fetch('/kv').then((r) => r.json()).then((cfg) => {
  currentCfg = cfg || {};
  $('#wakeWord').value = currentCfg.wakeWords && currentCfg.wakeWords[0] ? currentCfg.wakeWords[0] : '嘿辛蒂';
  $('#volume').value = currentCfg.volume ?? 1.0;
  $('#volLabel').textContent = Math.round(($('#volume').value) * 100) + '%';
  $('#autoStart').checked = !!currentCfg.autoStart;
  applyPlatformHints(currentCfg);
  applyDevices(currentCfg.audioDevices, currentCfg);
  return refreshDevices(currentCfg);
}).catch(() => {
  applyPlatformHints({});
  applyDevices(null, {});
});

$('#volume').addEventListener('input', (e) => {
  $('#volLabel').textContent = Math.round(e.target.value * 100) + '%';
});

$('#refreshDevices').onclick = () => refreshDevices(currentCfg);

$('#save').onclick = async () => {
  const cur = await fetch('/kv').then((r) => r.json()).catch(() => ({}));
  const cfg = Object.assign({}, cur, {
    wakeWords: [$('#wakeWord').value],
    volume: parseFloat($('#volume').value),
    autoStart: $('#autoStart').checked,
    inputDevice: $('#inputDevice').value,
    outputDevice: $('#outputDevice').value,
  });
  currentCfg = cfg;
  await fetch('/kv', { method: 'PUT', body: JSON.stringify(cfg) });
  await wakeBrain();
  new BroadcastChannel('earbud-speaker').postMessage({ type: 'settings-changed' });
  const btn = $('#save');
  btn.textContent = '已保存 ✓';
  setTimeout(() => { btn.textContent = '保存设置'; }, 1500);
};
