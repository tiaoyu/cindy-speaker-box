const $ = (s) => document.querySelector(s);

fetch('/kv').then((r) => r.json()).then((cfg) => {
  $('#wakeWord').value = cfg.wakeWords && cfg.wakeWords[0] ? cfg.wakeWords[0] : '嘿辛蒂';
  $('#volume').value = cfg.volume ?? 1.0;
  $('#volLabel').textContent = Math.round(($('#volume').value) * 100) + '%';
  $('#autoStart').checked = !!cfg.autoStart;
});

$('#volume').addEventListener('input', (e) => {
  $('#volLabel').textContent = Math.round(e.target.value * 100) + '%';
});

$('#save').onclick = async () => {
  const cfg = {
    wakeWords: [$('#wakeWord').value],
    volume: parseFloat($('#volume').value),
    autoStart: $('#autoStart').checked,
  };
  await fetch('/kv', { method: 'PUT', body: JSON.stringify(cfg) });
  new BroadcastChannel('earbud-speaker').postMessage({ type: 'settings-changed' });
  const btn = $('#save');
  btn.textContent = '已保存 ✓';
  setTimeout(() => { btn.textContent = '保存设置'; }, 1500);
};
