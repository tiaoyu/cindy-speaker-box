// earbud-speaker Node worker
// 链路: sox 录音(16k mono s16le raw) → KWS 唤醒 → VAD 截句 + 流式 ASR → 上报文本
//       main.js 拿到答案后调 speak() → 本地 TTS → sox 播放
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { URL } = require('node:url');

const ROOT = __dirname;
const SHERPA = path.join(ROOT, 'sherpa');
const SOX_DIR = path.join(ROOT, 'vendor', 'sox');
// 录音/播放统一走 sox:Windows 用随包 sox.exe,macOS/Linux 找 PATH 或 Homebrew 里的 sox
function resolveSox() {
  if (process.platform === 'win32') return path.join(SOX_DIR, 'sox.exe');
  const candidates = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'sox')),
    '/opt/homebrew/bin/sox',
    '/usr/local/bin/sox',
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}
function soxMissingMessage() {
  if (process.platform === 'win32') {
    return '缺少随包 sox.exe(node/vendor/sox),无法录音播放。请确认插件已完整安装,或重新导入 .cindy 包';
  }
  if (process.platform === 'darwin') {
    return '找不到 sox(录音/播放依赖)。macOS 请先安装: brew install sox';
  }
  return '找不到 sox(录音/播放依赖)。请用包管理器安装 sox,例如: sudo apt install sox';
}
const SOX = resolveSox();

const DATA_DIR = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'earbud-speaker')
  : path.join(os.homedir(), 'earbud-speaker');
const MODELS_DIR = path.join(DATA_DIR, 'models');

// 模型清单(下载 + 解压 + 引擎路径)。GitHub 直连为主,镜像兜底。
const MODELS = {
  kws: {
    dir: path.join(MODELS_DIR, 'kws'),
    tarName: 'kws.tar.bz2',
    urls: [
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2',
      'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2',
    ],
    topDirName: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
  },
  asr: {
    dir: path.join(MODELS_DIR, 'asr'),
    tarName: 'asr.tar.bz2',
    urls: [
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2',
      'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2',
    ],
    topDirName: 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
  },
  tts: {
    dir: path.join(MODELS_DIR, 'tts'),
    tarName: 'tts.tar.bz2',
    urls: [
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2',
      'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2',
    ],
    topDirName: 'vits-melo-tts-zh_en',
  },
  vad: {
    dir: MODELS_DIR,
    tarName: 'vad.onnx',
    urls: [
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
      'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    ],
    topDirName: null,
  },
};

// ---------------------------------------------------------------- JSON-RPC

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
function notify(method, params) {
  reply({ jsonrpc: '2.0', method, params });
}
function log(msg) {
  try {
    notify('log', { msg: String(msg).slice(0, 500), ts: Date.now() });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 状态

const state = {
  phase: 'UNINIT', // UNINIT / STOPPED / IDLE / LISTENING / THINKING / SPEAKING / DOWNLOADING
  config: {
    wakeWords: ['嘿Cindy'],       // 默认唤醒词(内置候选)
    volume: 1.0,                  // 0~2
    inputDevice: '',              // 空 = 默认
    outputDevice: '',             // 空 = 默认
  },
  listening: false,               // 用户开关
  engines: null,                  // { kws, asr, vad, tts }
  wasmModule: null,
  rec: null,                      // sox 录音子进程
  recBuf: Buffer.alloc(0),        // 未消费的 PCM(16k s16le)
  kwsStream: null,
  asrStream: null,
  vadInSpeech: false,
  vadSilenceMs: 0,
  listenStartedAt: 0,
  speakChild: null,
  downloading: false,
  lastUtterance: null,
  wakeUploads: Object.create(null),
};

const SR = 16000;
const TTS_SR = 22050;
const KWS_FRAME = 512;            // silero/kws 帧长
const ASR_CHUNK = 1600;           // 100ms

// ---------------------------------------------------------------- sherpa 引擎

function loadWasm() {
  if (state.wasmModule) return state.wasmModule;
  const m = {};
  // wasm 文件与本 js 同目录(sherpa loader 按 __dirname 找 .wasm)
  require(path.join(SHERPA, 'sherpa-onnx-wasm-nodejs.js'))(m);
  state.wasmModule = m;
  return m;
}

const T = (p) => p.replace(/\\/g, '/'); // wasm 内部 fopen 需要 / 路径

// 唤醒词: 内置候选词表(拼音已按声母/韵母分离,全部校验过能命中 tokens.txt)
const WAKE_PINYIN = {
  '嘿Cindy': ['h ēi s īn d ì @嘿Cindy', 'h ēi C I n d y @嘿Cindy'],
  '你好Cindy': ['n ǐ h ǎo s īn d ì @你好Cindy', 'n ǐ h ǎo C I n d y @你好Cindy'],
  '小Cindy': ['x iǎo s īn d ì @小Cindy', 'x iǎo C I n d y @小Cindy'],
  '嘿辛蒂': 'h ēi x īn d ì @嘿辛蒂',
  '你好辛蒂': 'n ǐ h ǎo x īn d ì @你好辛蒂',
  '小辛蒂': 'x iǎo x īn d ì @小辛蒂',
  '嘿小辛': 'h ēi x iǎo x īn @嘿小辛',
  '你好小辛': 'n ǐ h ǎo x iǎo x īn @你好小辛',
};

function kwsKeywordLines() {
  const kwLines = [];
  for (const w of state.config.wakeWords) {
    const py = WAKE_PINYIN[w];
    if (Array.isArray(py)) kwLines.push(...py);
    else if (py) kwLines.push(py);
    else log(`唤醒词「${w}」暂不支持,已跳过。可选:${Object.keys(WAKE_PINYIN).join('/')}`);
  }
  if (!kwLines.length) kwLines.push(...WAKE_PINYIN['嘿Cindy']);
  return kwLines;
}

function kwsKeywordText(extraLines) {
  const lines = kwsKeywordLines().concat(Array.isArray(extraLines) ? extraLines : []);
  const seen = new Set();
  const uniq = [];
  for (const line of lines) {
    const s = String(line || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  return uniq.join('\n') + '\n';
}

function kwsCreateConfig(kwsDir, keywords) {
  return {
    featConfig: { samplingRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${kwsDir}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`,
        decoder: `${kwsDir}/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`,
        joiner: `${kwsDir}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx`,
      },
      tokens: `${kwsDir}/tokens.txt`,
      numThreads: 1, provider: 'cpu', debug: 0, modelingUnit: 'cjkchar',
    },
    keywords,
    maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.0, keywordsThreshold: 0.25,
  };
}

function officialTestKeywordLines() {
  const p = path.join(MODELS.kws.dir, MODELS.kws.topDirName, 'test_wavs', 'test_keywords.txt');
  try {
    return fs.readFileSync(p, 'utf8').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function withTempKws(keywords, fn) {
  const kwsMod = require(path.join(SHERPA, 'sherpa-onnx-kws.js'));
  const kwsDir = T(path.join(MODELS.kws.dir, MODELS.kws.topDirName));
  const kws = kwsMod.createKws(loadWasm(), kwsCreateConfig(kwsDir, keywords));
  const prev = state.engines && state.engines.kws;
  if (!state.engines) state.engines = {};
  state.engines.kws = kws;
  try {
    return fn();
  } finally {
    if (prev) state.engines.kws = prev;
    else delete state.engines.kws;
    try { kws.free(); } catch { /* */ }
  }
}

function buildEngines() {
  const m = loadWasm();
  const kwsMod = require(path.join(SHERPA, 'sherpa-onnx-kws.js'));
  const asrMod = require(path.join(SHERPA, 'sherpa-onnx-asr.js'));
  const vadMod = require(path.join(SHERPA, 'sherpa-onnx-vad.js'));
  const ttsMod = require(path.join(SHERPA, 'sherpa-onnx-tts.js'));

  const kwsDir = T(path.join(MODELS.kws.dir, MODELS.kws.topDirName));
  const asrDir = T(path.join(MODELS.asr.dir, MODELS.asr.topDirName));
  const ttsDir = T(path.join(MODELS.tts.dir, MODELS.tts.topDirName));
  const vadModel = T(path.join(MODELS.vad.dir, MODELS.vad.tarName));

  const engines = {};
  engines.kws = kwsMod.createKws(m, kwsCreateConfig(kwsDir, kwsKeywordText()));

  engines.asr = asrMod.createOnlineRecognizer(m, {
    modelConfig: {
      transducer: {
        encoder: `${asrDir}/encoder-epoch-99-avg-1.int8.onnx`,
        decoder: `${asrDir}/decoder-epoch-99-avg-1.onnx`,
        joiner: `${asrDir}/joiner-epoch-99-avg-1.int8.onnx`,
      },
      tokens: `${asrDir}/tokens.txt`,
      numThreads: 1, provider: 'cpu', debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  });

  engines.vad = vadMod.createVad(m, {
    sileroVad: {
      model: vadModel,
      threshold: 0.5,
      minSilenceDuration: 0.7,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 20,
      windowSize: KWS_FRAME,
    },
    sampleRate: SR, numThreads: 1, debug: 0, bufferSizeInSeconds: 60,
  });

  engines.tts = ttsMod.createOfflineTts(m, {
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: {
        model: `${ttsDir}/model.onnx`,
        lexicon: `${ttsDir}/lexicon.txt`,
        tokens: `${ttsDir}/tokens.txt`,
      },
    },
    ruleFsts: `${ttsDir}/phone.fst,${ttsDir}/date.fst,${ttsDir}/number.fst,${ttsDir}/new_heteronym.fst`,
    maxNumSentences: 1,
  });

  return engines;
}

function enginesReady() {
  try {
    for (const k of ['kws', 'asr', 'tts']) {
      const mm = MODELS[k];
      const sub = mm.topDirName ? path.join(mm.dir, mm.topDirName) : mm.dir;
      if (!fs.existsSync(sub)) return false;
    }
    if (!fs.existsSync(path.join(MODELS.vad.dir, MODELS.vad.tarName))) return false;
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- 音频设备

function asDeviceList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function listWindowsWaveDevices() {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'try {',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class EarbudWaveDev {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct InCaps {',
    '    public ushort wMid; public ushort wPid; public uint vDriverVersion;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;',
    '    public uint dwFormats; public ushort wChannels; public ushort wReserved1;',
    '  }',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct OutCaps {',
    '    public ushort wMid; public ushort wPid; public uint vDriverVersion;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;',
    '    public uint dwFormats; public ushort wChannels; public ushort wReserved1; public uint dwSupport;',
    '  }',
    '  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int waveInGetNumDevs();',
    '  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int waveOutGetNumDevs();',
    '  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int waveInGetDevCaps(uint id, out InCaps caps, uint size);',
    '  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int waveOutGetDevCaps(uint id, out OutCaps caps, uint size);',
    '}',
    '"@',
    '} catch {',
    '  if ($_.Exception.Message -notmatch "already exists") { throw }',
    '}',
    '$inputs = @()',
    'for ($i = 0; $i -lt [EarbudWaveDev]::waveInGetNumDevs(); $i++) {',
    '  $c = New-Object EarbudWaveDev+InCaps',
    '  [void][EarbudWaveDev]::waveInGetDevCaps([uint32]$i, [ref]$c, [uint32][Runtime.InteropServices.Marshal]::SizeOf($c))',
    '  $n = [string]$c.szPname',
    '  if (-not $n) { $n = [string]$i }',
    '  $inputs += @{ id = $n; name = $n }',
    '}',
    '$outputs = @()',
    'for ($i = 0; $i -lt [EarbudWaveDev]::waveOutGetNumDevs(); $i++) {',
    '  $c = New-Object EarbudWaveDev+OutCaps',
    '  [void][EarbudWaveDev]::waveOutGetDevCaps([uint32]$i, [ref]$c, [uint32][Runtime.InteropServices.Marshal]::SizeOf($c))',
    '  $n = [string]$c.szPname',
    '  if (-not $n) { $n = [string]$i }',
    '  $outputs += @{ id = $n; name = $n }',
    '}',
    '@{ inputs = @($inputs); outputs = @($outputs) } | ConvertTo-Json -Compress -Depth 5',
  ].join('\n');
  const ps1 = path.join(os.tmpdir(), 'earbud-speaker-wave-devs.ps1');
  fs.writeFileSync(ps1, script, 'utf8');
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1,
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const text = String(out || '').replace(/^﻿/, '').trim();
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error('未得到设备列表');
  const json = JSON.parse(line);
  const norm = (d) => {
    const id = String(d.id || d.name || '').trim();
    const name = String(d.name || d.id || '').trim() || id;
    return { id, name };
  };
  return {
    inputs: asDeviceList(json.inputs).map(norm).filter((d) => d.id),
    outputs: asDeviceList(json.outputs).map(norm).filter((d) => d.id),
    driver: 'waveaudio',
  };
}

function flagYes(v) {
  if (v === true || v === 1) return true;
  const s = String(v || '').toLowerCase();
  return s === 'spaudio_yes' || s === 'yes' || s === 'true';
}

function walkAudioNodes(nodes, acc) {
  for (const it of nodes || []) {
    if (!it || typeof it !== 'object') continue;
    if (Array.isArray(it._items)) walkAudioNodes(it._items, acc);
    const name = String(it._name || '').trim();
    if (!name) continue;
    const inputish = flagYes(it.coreaudio_device_input) || it.coreaudio_input_source || it.coreaudio_default_audio_input_device;
    const outputish = flagYes(it.coreaudio_device_output) || it.coreaudio_output_source || it.coreaudio_default_audio_output_device;
    if (inputish) acc.inputs.push({ id: name, name });
    if (outputish) acc.outputs.push({ id: name, name });
  }
}

function listDarwinDevices() {
  const bin = fs.existsSync('/usr/sbin/system_profiler') ? '/usr/sbin/system_profiler' : 'system_profiler';
  const raw = execFileSync(bin, ['SPAudioDataType', '-json'], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(raw);
  const acc = { inputs: [], outputs: [] };
  walkAudioNodes(data.SPAudioDataType || [], acc);
  const uniq = (arr) => {
    const seen = new Set();
    return arr.filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  };
  return { inputs: uniq(acc.inputs), outputs: uniq(acc.outputs), driver: 'coreaudio' };
}

function parsePactlShort(text, kind) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const cols = line.split('\t');
    const id = cols[1] || cols[0];
    const name = cols[1] || cols[0];
    return { id, name: name + (kind ? ` (${kind})` : '') };
  }).filter((d) => d.id);
}

function listLinuxDevices() {
  try {
    const sources = execFileSync('pactl', ['list', 'short', 'sources'], { encoding: 'utf8', timeout: 8000 });
    const sinks = execFileSync('pactl', ['list', 'short', 'sinks'], { encoding: 'utf8', timeout: 8000 });
    return {
      inputs: parsePactlShort(sources, 'source').filter((d) => !/\.monitor$/i.test(d.id)),
      outputs: parsePactlShort(sinks, 'sink'),
      driver: 'pulseaudio',
    };
  } catch { /* fall through to alsa */ }
  const parseAlsa = (text, prefix) => {
    const out = [];
    let card = '';
    for (const line of String(text || '').split(/\r?\n/)) {
      const cm = line.match(/^card\s+(\d+):\s+(\S+)\s+\[([^\]]+)\]/i);
      if (cm) { card = cm[1]; continue; }
      const dm = line.match(/^(device|子设备)\s+(\d+):\s+([^\[]+)\[([^\]]+)\]/i) || line.match(/^device\s+(\d+):/i);
      if (dm && card !== '') {
        const dev = dm[1] || dm[2];
        const id = `hw:${card},${dev}`;
        out.push({ id, name: `${prefix} ${id}` });
      }
    }
    return out;
  };
  let inputs = [];
  let outputs = [];
  try { inputs = parseAlsa(execFileSync('arecord', ['-l'], { encoding: 'utf8', timeout: 8000 }), '录音'); } catch { /* */ }
  try { outputs = parseAlsa(execFileSync('aplay', ['-l'], { encoding: 'utf8', timeout: 8000 }), '播放'); } catch { /* */ }
  return { inputs, outputs, driver: 'alsa' };
}

function listAudioDevices() {
  try {
    if (process.platform === 'win32') return listWindowsWaveDevices();
    if (process.platform === 'darwin') return listDarwinDevices();
    return listLinuxDevices();
  } catch (e) {
    log('枚举音频设备失败: ' + String(e && e.message || e).slice(0, 200));
    return { inputs: [], outputs: [], driver: '', error: String(e && e.message || e).slice(0, 200) };
  }
}

function soxAudioDriver() {
  if (process.platform === 'win32') return 'waveaudio';
  if (process.platform === 'darwin') return 'coreaudio';
  return null;
}

function soxDeviceArgs(device) {
  const name = String(device || '').trim();
  const driver = soxAudioDriver() || (name.startsWith('hw:') ? 'alsa' : (name ? 'pulseaudio' : null));
  // 随包 Windows sox 只编了 waveaudio:裸 -d 会报 "no default audio device configured"
  if (!name) return driver ? ['-t', driver, '-d'] : ['-d'];
  return driver ? ['-t', driver, name] : ['-d'];
}

function soxFailHint(stderr) {
  const s = String(stderr || '').replace(/\s+/g, ' ').trim();
  if (/no default audio device/i.test(s)) return 'SoX 打不开系统默认录音设备,请在插件设置里明确选择麦克风后保存';
  if (/not found/i.test(s) || /can't open input/i.test(s)) return '所选麦克风打不开,请刷新设备列表后重新选择并保存';
  if (/can not open audio device/i.test(s)) return '无法打开音频设备,请检查耳机是否连接,并在插件设置里选择输入设备';
  const m = s.match(/FAIL[^\n]{0,160}/i);
  if (m) return m[0].slice(0, 180);
  return s.slice(0, 180);
}

function soxRecArgs() {
  return ['-q', ...soxDeviceArgs(state.config.inputDevice), '-t', 'raw', '-r', String(SR), '-c', '1', '-b', '16', '-e', 'signed-integer', '-'];
}

function startRec() {
  if (state.rec) return;
  const args = soxRecArgs();
  log('录音: sox ' + args.join(' '));
  const child = spawn(SOX, args, { windowsHide: true });
  const startedAt = Date.now();
  let gotData = false;
  let errBuf = '';
  child.on('error', (e) => {
    log('录音进程启动失败: ' + e.message + '(请在插件设置里选择麦克风,或确认耳机已连接)');
    state.rec = null;
    notify('rec-error', { message: '录音进程启动失败: ' + e.message });
    setPhase('IDLE');
  });
  child.on('exit', (code) => {
    if (state.rec !== child) return;
    state.rec = null;
    // 启动后极短时间内没收到任何音频就退出 = 打不开录音设备,如实上报而不是静默停在 IDLE
    if (!gotData && Date.now() - startedAt < 3000) {
      const hint = soxFailHint(errBuf) || ('没有可用的麦克风输入设备(退出码 ' + code + ')');
      log('录音设备打开失败: ' + hint);
      notify('rec-error', { message: hint });
      stopAll();
    }
  });
  child.stderr.on('data', (d) => {
    errBuf += String(d || '');
    if (errBuf.length > 1000) errBuf = errBuf.slice(-1000);
  });
  child.stdout.on('data', (chunk) => { gotData = true; onPcm(chunk); });
  state.rec = child;
}

function stopRec() {
  if (!state.rec) return;
  try { state.rec.kill(); } catch { /* ignore */ }
  state.rec = null;
  state.recBuf = Buffer.alloc(0);
}

// ---------------------------------------------------------------- 音频消费

function feedFloat32(buf) {
  const n = buf.length / 2;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(i * 2) / 32768;
  return f;
}

function resetKws() {
  if (!state.engines) return;
  if (state.kwsStream) { try { state.kwsStream.free(); } catch { /* */ } }
  state.kwsStream = state.engines.kws.createStream();
}

function resetAsr() {
  if (!state.engines) return;
  if (state.asrStream) { try { state.asrStream.inputFinished(); } catch { /* */ } try { state.asrStream.free(); } catch { /* */ } }
  state.asrStream = state.engines.asr.createStream();
}

function onPcm(chunk) {
  state.recBuf = Buffer.concat([state.recBuf, chunk]);
  const bytes = KWS_FRAME * 2;
  while (state.recBuf.length >= bytes) {
    const frame = state.recBuf.subarray(0, bytes);
    state.recBuf = state.recBuf.subarray(bytes);
    const f = feedFloat32(frame);
    handleFrame(f);
  }
}

function handleFrame(f) {
  if (state.phase === 'IDLE') {
    // 唤醒词检测
    if (state.kwsStream && state.engines) {
      state.kwsStream.acceptWaveform(SR, f);
      const kws = state.engines.kws;
      while (kws.isReady(state.kwsStream)) kws.decode(state.kwsStream);
      const r = kws.getResult(state.kwsStream);
      if (r && r.keyword) {
        log('唤醒: ' + r.keyword);
        kws.reset(state.kwsStream);
        beginListening();
      }
    }
  } else if (state.phase === 'LISTENING') {
    const asr = state.engines.asr;
    if (state.asrStream) {
      state.asrStream.acceptWaveform(SR, f);
      while (asr.isReady(state.asrStream)) asr.decode(state.asrStream);
    }
    // VAD 截句
    const vad = state.engines.vad;
    vad.acceptWaveform(f);
    let speechSeg = null;
    while (!vad.isEmpty()) {
      const seg = vad.front(); vad.pop();
      if (seg && seg.samples && seg.samples.length) speechSeg = seg;
    }
    if (vad.isDetected()) {
      state.vadInSpeech = true;
      state.vadSilenceMs = 0;
    } else if (state.vadInSpeech && speechSeg) {
      state.vadSilenceMs += (KWS_FRAME / SR) * 1000;
    }
    const elapsed = Date.now() - state.listenStartedAt;
    if (state.vadInSpeech && state.vadSilenceMs >= 800) {
      finishListening(); // 静音 0.8s 截句
    } else if (elapsed > 30000) {
      log('聆听超时(30s),回到待命');
      resetListening();
      setPhase('IDLE');
    }
  }
}

function beginListening() {
  setPhase('LISTENING');
  state.vadInSpeech = false;
  state.vadSilenceMs = 0;
  state.listenStartedAt = Date.now();
  state.engines.vad.reset();
  resetAsr();
  playBeep();
}

function resetListening() {
  state.vadInSpeech = false;
  state.vadSilenceMs = 0;
  if (state.engines) { try { state.engines.vad.reset(); } catch { /* */ } }
  resetAsr();
}

function finishListening() {
  let text = '';
  try {
    const r = state.engines.asr.getResult(state.asrStream);
    if (r && r.text) text = String(r.text).trim();
  } catch { /* */ }
  resetListening();
  if (!text || text.length < 2) {
    log('未听清,回到待命');
    setPhase('IDLE');
    return;
  }
  state.lastUtterance = { text, ts: Date.now() };
  setPhase('THINKING');
  stopRec(); // 思考与播报期间不录音(蓝牙 HFP 冲突)
  notify('utterance', { text });
}

// ---------------------------------------------------------------- 播放

function beepPcm(freq, durMs, sr) {
  const n = Math.floor((sr * durMs) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, i / (n * 0.1)) * Math.min(1, (n - i) / (n * 0.1));
    const v = Math.sin(2 * Math.PI * freq * t) * env * 0.25;
    b.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return b;
}

function playRaw(pcmBuf, sr, volume, cb) {
  const args = [
    '-q', '-v', String(Math.max(0.1, Math.min(2, volume))),
    '-t', 'raw', '-r', String(sr), '-c', '1', '-b', '16', '-e', 'signed-integer', '-',
    ...soxDeviceArgs(state.config.outputDevice),
  ];
  const child = spawn(SOX, args, { windowsHide: true });
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    state.speakChild = null;
    cb && cb(ok);
  };
  child.on('error', (e) => { log('播放失败: ' + e.message); finish(false); });
  child.stderr.on('data', (d) => {
    const s = String(d || '');
    if (/no default audio device|can not open audio device|can't open output|not found/i.test(s)) {
      log('播放设备打开失败: ' + soxFailHint(s));
    }
  });
  child.on('exit', () => finish(true));
  state.speakChild = child;
  child.stdin.end(pcmBuf);
}

function playBeep() {
  playRaw(beepPcm(880, 120, TTS_SR), TTS_SR, state.config.volume * 0.6, null);
}

function doSpeak(text, cb) {
  if (!state.engines) { cb && cb(false); return; }
  setPhase('SPEAKING');
  let audio;
  try {
    const t0 = Date.now();
    audio = state.engines.tts.generate({ text, sid: 0, speed: 1.0 });
    log(`TTS 合成 ${(audio.samples.length / audio.sampleRate).toFixed(1)}s 音频,耗时 ${Date.now() - t0}ms`);
  } catch (e) {
    log('TTS 合成失败: ' + (e && e.message));
    setPhase('IDLE');
    cb && cb(false);
    return;
  }
  const n = audio.samples.length;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, audio.samples[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const sr = audio.sampleRate || TTS_SR;
  playRaw(pcm, sr, state.config.volume, () => {
    setPhase('IDLE');
    cb && cb(true);
  });
}

// ---------------------------------------------------------------- 模型下载

function downloadFile(urls, dest, onProgress, cb) {
  let idx = 0;
  const attempt = () => {
    if (idx >= urls.length) { cb(new Error('全部下载源均失败')); return; }
    const url = urls[idx++];
    log('下载: ' + url);
    const proto = url.startsWith('https') ? require('node:https') : require('node:http');
    const req = proto.get(url, { headers: { 'User-Agent': 'earbud-speaker' }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        urls.push(res.headers.location);
        attempt();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        attempt();
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (d) => {
        got += d.length;
        if (total) onProgress(got, total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => cb(null)));
      out.on('error', (e) => { try { fs.unlinkSync(dest); } catch { /* */ } cb(e); });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', () => attempt());
  };
  attempt();
}

function extractTarBz2(tarPath, destDir, cb) {
  // Windows 10+ 自带 bsdtar;macOS 自带 /usr/bin/tar(同为 bsdtar);Linux 一般也有 tar
  let tar;
  if (process.platform === 'win32') {
    tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  } else {
    tar = 'tar';
  }
  try {
    execFileSync(tar, ['-xjf', tarPath, '-C', destDir], { stdio: 'pipe', timeout: 600000 });
    cb(null);
  } catch (e) {
    cb(e);
  }
}

function downloadModels(cb) {
  if (state.downloading) { cb && cb(new Error('已有下载在进行')); return; }
  state.downloading = true;
  setPhase('DOWNLOADING');
  const jobs = Object.entries(MODELS);
  let i = 0;
  const next = (err) => {
    if (err) {
      log('模型下载失败: ' + err.message + '(可稍后在面板重试)');
      state.downloading = false;
      setPhase('STOPPED');
      cb && cb(err);
      return;
    }
    if (i >= jobs.length) {
      state.downloading = false;
      log('全部模型就绪');
      cb && cb(null);
      return;
    }
    const [key, mm] = jobs[i++];
    const dest = mm.topDirName ? path.join(MODELS_DIR, mm.tarName) : path.join(mm.dir, mm.tarName);
    if (mm.topDirName && fs.existsSync(path.join(mm.dir, mm.topDirName))) { next(null); return; }
    if (!mm.topDirName && fs.existsSync(dest)) { next(null); return; }
    fs.mkdirSync(mm.dir, { recursive: true });
    let lastPct = -1;
    downloadFile(mm.urls.slice(), dest, (got, total) => {
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        notify('dl-progress', { key, pct, name: mm.tarName });
      }
    }, (e) => {
      if (e) { next(e); return; }
      if (mm.topDirName) {
        notify('dl-progress', { key, pct: 100, name: mm.tarName });
        log('解压 ' + mm.tarName + ' ...');
        extractTarBz2(dest, mm.dir, (e2) => {
          if (e2) { next(new Error('解压失败: ' + e2.message + '(压缩包已保留,重试无需重新下载)')); return; }
          try { fs.unlinkSync(dest); } catch { /* */ }
          next(null);
        });
      } else {
        notify('dl-progress', { key, pct: 100, name: mm.tarName });
        next(null);
      }
    });
  };
  next(null);
}

// ---------------------------------------------------------------- 状态机

function setPhase(p) {
  if (state.phase === p) return;
  state.phase = p;
  notify('state', { phase: p, listening: state.listening });
}

function ensureEngines() {
  if (!enginesReady()) {
    notify('need-models', {});
    return { ok: false, message: '语音模型未就绪,请先在面板点「下载语音模型」' };
  }
  if (!state.engines) {
    log('加载语音引擎(首次约 2-5 秒)...');
    try {
      state.engines = buildEngines();
    } catch (e) {
      const message = '引擎加载失败: ' + String(e && e.message).slice(0, 300);
      log(message);
      state.engines = null;
      return { ok: false, message };
    }
  }
  return { ok: true };
}

function convertToPcm16k(srcPath) {
  if (!SOX || !fs.existsSync(SOX)) throw new Error(soxMissingMessage());
  const dest = path.join(os.tmpdir(), 'earbud-wake-test-' + Date.now() + '.raw');
  try {
    execFileSync(SOX, [
      srcPath,
      '-t', 'raw', '-r', String(SR), '-c', '1', '-b', '16', '-e', 'signed-integer',
      dest,
    ], { stdio: 'pipe', timeout: 30000, windowsHide: true });
    const buf = fs.readFileSync(dest);
    const maxBytes = SR * 2 * 30; // 最多测 30 秒
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  } finally {
    try { fs.unlinkSync(dest); } catch { /* */ }
  }
}

function consumeKwsHits(stream, keywords, seen) {
  const kws = state.engines.kws;
  while (kws.isReady(stream)) kws.decode(stream);
  const r = kws.getResult(stream);
  if (r && r.keyword) {
    const kw = String(r.keyword);
    if (kw && !seen.has(kw)) {
      seen.add(kw);
      keywords.push(kw);
    }
    kws.reset(stream);
    return true;
  }
  return false;
}

function scanWakeKeywords(pcm) {
  const stream = state.engines.kws.createStream();
  const keywords = [];
  const seen = new Set();
  try {
    const bytes = KWS_FRAME * 2;
    for (let off = 0; off + bytes <= pcm.length; off += bytes) {
      stream.acceptWaveform(SR, feedFloat32(pcm.subarray(off, off + bytes)));
      consumeKwsHits(stream, keywords, seen);
    }
    const rem = pcm.length % bytes;
    if (rem >= 2) {
      const last = Buffer.alloc(bytes);
      pcm.copy(last, 0, pcm.length - rem);
      stream.acceptWaveform(SR, feedFloat32(last));
      consumeKwsHits(stream, keywords, seen);
    }
    // 尾部补 0.8s 静音,让 trailing blank 触发(短录音否则可能憋在解码器里)
    const silence = new Float32Array(Math.round(SR * 0.8));
    stream.acceptWaveform(SR, silence);
    consumeKwsHits(stream, keywords, seen);
    try { stream.inputFinished(); } catch { /* */ }
    consumeKwsHits(stream, keywords, seen);
  } finally {
    try { stream.free(); } catch { /* */ }
  }
  return keywords;
}

function testWakeFromPath(src, displayName) {
  const ready = ensureEngines();
  if (!ready.ok) return ready;
  if (!src) return { ok: false, message: '请提供音频文件路径或上传音频内容' };
  if (!fs.existsSync(src)) return { ok: false, message: '找不到音频文件: ' + src };
  let pcm;
  try {
    pcm = convertToPcm16k(src);
  } catch (e) {
    return { ok: false, message: '音频转码失败: ' + String(e && e.message || e).slice(0, 200) };
  }
  if (!pcm || pcm.length < KWS_FRAME * 2) {
    return { ok: false, message: '转码后音频太短,无法检测唤醒词' };
  }
  const extra = officialTestKeywordLines();
  const keywords = extra.length
    ? withTempKws(kwsKeywordText(extra), () => scanWakeKeywords(pcm))
    : scanWakeKeywords(pcm);
  const durationMs = Math.round((pcm.length / 2) / SR * 1000);
  const result = {
    ok: true,
    triggered: keywords.length > 0,
    keywords,
    durationMs,
    bytes: pcm.length,
    file: displayName || path.basename(src),
  };
  log(result.triggered
    ? ('唤醒词自测命中: ' + keywords.join('/') + ' (' + durationMs + 'ms)')
    : ('唤醒词自测未命中 (' + durationMs + 'ms, 当前词: ' + (state.config.wakeWords || []).join('/') + ')'));
  return result;
}

function testWakeFile(params) {
  let src = String((params && params.filePath) || '').trim();
  let tmpSrc = '';
  if (!src && params && params.audioBase64) {
    const rawName = String(params.filename || 'wake-test.wav');
    const filename = rawName.replace(/[^a-zA-Z0-9._\-一-龥]/g, '_').slice(0, 80) || 'wake-test.wav';
    tmpSrc = path.join(os.tmpdir(), 'earbud-wake-src-' + Date.now() + '-' + filename);
    let buf;
    try {
      buf = Buffer.from(String(params.audioBase64), 'base64');
    } catch {
      return { ok: false, message: '音频内容不是合法的 base64' };
    }
    if (!buf.length) return { ok: false, message: '音频内容为空' };
    if (buf.length > 20 * 1024 * 1024) return { ok: false, message: '音频超过 20MB,请剪短后再测' };
    fs.writeFileSync(tmpSrc, buf);
    src = tmpSrc;
  }
  try {
    return testWakeFromPath(src, params && params.filename);
  } finally {
    if (tmpSrc) try { fs.unlinkSync(tmpSrc); } catch { /* */ }
  }
}

function wakeTestBegin(params) {
  const id = String((params && params.id) || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!id) return { ok: false, message: '缺少上传 id' };
  const rawName = String((params && params.filename) || 'wake-test.wav');
  const filename = rawName.replace(/[^a-zA-Z0-9._\-一-龥]/g, '_').slice(0, 80) || 'wake-test.wav';
  const filePath = path.join(os.tmpdir(), 'earbud-wake-up-' + id + '-' + filename);
  try { fs.unlinkSync(filePath); } catch { /* */ }
  state.wakeUploads[id] = { filePath, filename, bytes: 0 };
  return { ok: true, id };
}

function wakeTestChunk(params) {
  const id = String((params && params.id) || '');
  const up = state.wakeUploads[id];
  if (!up) return { ok: false, message: '上传会话不存在,请重新选择文件' };
  let buf;
  try {
    buf = Buffer.from(String((params && params.data) || ''), 'base64');
  } catch {
    return { ok: false, message: '分片不是合法的 base64' };
  }
  if (!buf.length) return { ok: true, bytes: up.bytes };
  if (up.bytes + buf.length > 20 * 1024 * 1024) return { ok: false, message: '音频超过 20MB,请剪短后再测' };
  fs.appendFileSync(up.filePath, buf);
  up.bytes += buf.length;
  return { ok: true, bytes: up.bytes };
}

function wakeTestFinish(params) {
  const id = String((params && params.id) || '');
  const up = state.wakeUploads[id];
  delete state.wakeUploads[id];
  if (!up) return { ok: false, message: '上传会话不存在,请重新选择文件' };
  try {
    return testWakeFromPath(up.filePath, up.filename);
  } finally {
    try { fs.unlinkSync(up.filePath); } catch { /* */ }
  }
}

function applyAndStart() {
  const ready = ensureEngines();
  if (!ready.ok) {
    setPhase('STOPPED');
    return false;
  }
  if (!SOX || !fs.existsSync(SOX)) {
    log(soxMissingMessage());
    setPhase('STOPPED');
    return false;
  }
  resetKws();
  resetAsr();
  startRec();
  setPhase('IDLE');
  return true;
}

function stopAll() {
  state.listening = false;
  stopRec();
  try { state.speakChild && state.speakChild.kill(); } catch { /* */ }
  setPhase('STOPPED');
}

// ---------------------------------------------------------------- RPC 处理

const handlers = {
  init(params) {
    if (params && params.config) Object.assign(state.config, params.config);
    const ready = enginesReady();
    return { ready, phase: state.phase, modelsDir: MODELS_DIR, platform: process.platform };
  },
  configure(params) {
    const prevWake = JSON.stringify(state.config.wakeWords || []);
    const prevIn = state.config.inputDevice || '';
    const prevOut = state.config.outputDevice || '';
    if (params && params.config) Object.assign(state.config, params.config);
    if (state.listening) {
      const wakeChanged = JSON.stringify(state.config.wakeWords || []) !== prevWake;
      const deviceChanged = (state.config.inputDevice || '') !== prevIn || (state.config.outputDevice || '') !== prevOut;
      if (wakeChanged) state.engines = null; // 唤醒词变了才重建引擎
      if (wakeChanged || deviceChanged) {
        try { stopRec(); } catch { /* */ }
        state.listening = applyAndStart();
      }
      notify('state', { phase: state.phase, listening: state.listening });
    }
    return { ok: true, config: state.config };
  },
  listDevices() {
    const listed = listAudioDevices();
    return {
      ok: !listed.error,
      inputs: listed.inputs || [],
      outputs: listed.outputs || [],
      driver: listed.driver || '',
      error: listed.error || '',
      inputDevice: state.config.inputDevice || '',
      outputDevice: state.config.outputDevice || '',
    };
  },
  start(params) {
    if (params && params.config) Object.assign(state.config, params.config);
    state.listening = true;
    const ok = applyAndStart();
    return { ok, phase: state.phase, inputDevice: state.config.inputDevice || '', outputDevice: state.config.outputDevice || '' };
  },
  stop() {
    stopAll();
    return { ok: true };
  },
  status() {
    return {
      phase: state.phase,
      listening: state.listening,
      modelsReady: enginesReady(),
      modelsDir: MODELS_DIR,
      platform: process.platform,
      wakeWords: state.config.wakeWords,
      inputDevice: state.config.inputDevice || '',
      outputDevice: state.config.outputDevice || '',
      lastUtterance: state.lastUtterance,
    };
  },
  speak(params) {
    const text = String((params && params.text) || '').trim();
    if (!text) return { ok: false, message: 'text 不能为空' };
    if (state.listening) stopRec();
    doSpeak(text, () => {
      if (state.listening) startRec(); // 播完回到待命继续听唤醒词
    });
    return { ok: true, async: true };
  },
  utteranceDirect(params) {
    // 面板/AI 直接用文字走一遍"提问"链路(不经语音)
    const text = String((params && params.text) || '').trim();
    if (!text) return { ok: false, message: 'text 不能为空' };
    if (state.phase === 'LISTENING') { resetListening(); stopRec(); }
    setPhase('THINKING');
    notify('utterance', { text });
    return { ok: true };
  },
  testWakeFile(params) {
    return testWakeFile(params || {});
  },
  wakeTestBegin(params) {
    return wakeTestBegin(params || {});
  },
  wakeTestChunk(params) {
    return wakeTestChunk(params || {});
  },
  wakeTestFinish(params) {
    return wakeTestFinish(params || {});
  },
  downloadModels() {
    downloadModels((err) => {
      notify('dl-done', { ok: !err, message: err ? err.message : '' });
      if (!err && state.listening) applyAndStart();
    });
    return { ok: true, async: true };
  },
};

readline_loop: {
  const readline = require('node:readline');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let request;
    try { request = JSON.parse(line); } catch {
      reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const handler = request.method && handlers[request.method];
    if (!handler) {
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    try {
      const result = handler(request.params || {});
      reply({ jsonrpc: '2.0', id: request.id, result });
    } catch (e) {
      reply({
        jsonrpc: '2.0', id: request.id,
        error: { code: -32000, message: String(e && e.message || e).slice(0, 400) },
      });
    }
  });
}

log('worker ready (pid ' + process.pid + ')');
setPhase('UNINIT');
