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
const SOX = path.join(SOX_DIR, 'sox.exe');

const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'earbud-speaker');
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
    wakeWords: ['嘿辛蒂'],        // 中文唤醒词(内置候选)
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

  // 唤醒词: 内置候选词表(拼音已按声母/韵母分离,全部校验过能命中 tokens.txt)
  const WAKE_PINYIN = {
    '嘿辛蒂': 'h ēi x īn d ì @嘿辛蒂',
    '你好辛蒂': 'n ǐ h ǎo x īn d ì @你好辛蒂',
    '小辛蒂': 'x iǎo x īn d ì @小辛蒂',
    '嘿小辛': 'h ēi x iǎo x īn @嘿小辛',
    '你好小辛': 'n ǐ h ǎo x iǎo x īn @你好小辛',
  };
  const kwLines = [];
  for (const w of state.config.wakeWords) {
    const py = WAKE_PINYIN[w];
    if (py) kwLines.push(py);
    else log(`唤醒词「${w}」暂不支持,已跳过。可选:${Object.keys(WAKE_PINYIN).join('/')}`);
  }
  if (!kwLines.length) kwLines.push(WAKE_PINYIN['嘿辛蒂']);

  engines.kws = kwsMod.createKws(m, {
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
    keywords: kwLines.join('\n') + '\n',
    maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.0, keywordsThreshold: 0.25,
  });

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

// ---------------------------------------------------------------- sox 录音

function soxRecArgs() {
  const args = ['-q'];
  if (state.config.inputDevice) args.push('-d', state.config.inputDevice);
  else args.push('-d');
  args.push('-t', 'raw', '-r', String(SR), '-c', '1', '-b', '16', '-e', 'signed-integer', '-');
  return args;
}

function startRec() {
  if (state.rec) return;
  const child = spawn(SOX, soxRecArgs(), { windowsHide: true });
  child.on('error', (e) => {
    log('录音进程启动失败: ' + e.message + '(请确认蓝牙耳机麦克风已连接并设为默认设备)');
    state.rec = null;
    setPhase('IDLE');
  });
  child.on('exit', () => { if (state.rec === child) state.rec = null; });
  child.stderr.on('data', (d) => { /* sox stderr 忽略,避免噪声 */ });
  child.stdout.on('data', (chunk) => onPcm(chunk));
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
  const args = ['-q', '-v', String(Math.max(0.1, Math.min(2, volume)))];
  if (state.config.outputDevice) args.push(state.config.outputDevice);
  args.push('-t', 'raw', '-r', String(sr), '-c', '1', '-b', '16', '-e', 'signed-integer', '-', '-d');
  const child = spawn(SOX, args, { windowsHide: true });
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    state.speakChild = null;
    cb && cb(ok);
  };
  child.on('error', (e) => { log('播放失败: ' + e.message); finish(false); });
  child.on('exit', () => finish(true));
  child.stderr.on('data', () => { /* ignore */ });
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
  // Windows 10+ 自带 bsdtar,支持 .tar.bz2
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
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
          try { fs.unlinkSync(dest); } catch { /* */ }
          if (e2) { next(new Error('解压失败: ' + e2.message)); return; }
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

function applyAndStart() {
  if (!enginesReady()) {
    notify('need-models', {});
    setPhase('STOPPED');
    return false;
  }
  if (!fs.existsSync(SOX)) {
    log('缺少随包 sox.exe(vendor/sox),无法录音播放');
    setPhase('STOPPED');
    return false;
  }
  if (!state.engines) {
    log('加载语音引擎(首次约 2-5 秒)...');
    try {
      state.engines = buildEngines();
    } catch (e) {
      log('引擎加载失败: ' + String(e && e.message).slice(0, 300));
      state.engines = null;
      setPhase('STOPPED');
      return false;
    }
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
    return { ready, phase: state.phase, modelsDir: MODELS_DIR };
  },
  configure(params) {
    if (params && params.config) Object.assign(state.config, params.config);
    if (state.listening) {
      // 重载唤醒词
      state.engines = null; // 触发重建
      try { state.rec && stopRec(); } catch { /* */ }
      state.listening = applyAndStart();
      notify('state', { phase: state.phase, listening: state.listening });
    }
    return { ok: true, config: state.config };
  },
  start() {
    state.listening = true;
    const ok = applyAndStart();
    return { ok, phase: state.phase };
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
      wakeWords: state.config.wakeWords,
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
