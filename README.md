# 耳机智能音箱 (cindy-speaker-box)

把蓝牙耳机变成智能音箱的 [Cindy](https://github.com/makecindy/cindy) 插件。

说唤醒词（默认「嘿Cindy」）→ 听到"嘀"声后说出问题 → 停顿一下 → Cindy 思考后把口语化答案通过耳机播报回来。每个问题在 Cindy 侧边栏都有独立会话，可以随时回看完整回答。

当前支持 **Windows** 与 **macOS**。语音引擎（sherpa-onnx WASM）两边相同；录音/播放依赖 SoX，Windows 随包分发，macOS 需自行安装。

## 特性

- **全离线语音链路**：唤醒词检测、语音识别、语音合成全部本地运行（[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WASM），无需任何 API key，语音数据不出本机
- **Cindy 派活 / 快速通道双链路**：简单问题走 Cindy 快速通道（几秒回），复杂问题自动转 errand 派活（Agent 可动用工具）
- **口语化播报**：答案强制精简为 3~5 句口语（中文数字读法、无 markdown），适合"听"
- **Windows 随包运行时**：sherpa-onnx WASM 引擎 + SoX 音频工具随插件分发，Windows 用户无需安装任何依赖
- **macOS 兼容**：使用系统 `tar` 解压模型、Homebrew / PATH 中的 `sox` 录音播放；模型目录在 `~/earbud-speaker`

## 工作原理

```
待命: SoX 录音(16k) → KWS 唤醒词检测（silero zipformer）
唤醒: "嘀"提示音 → 流式 ASR 听写（zipformer int8）+ silero VAD 静音截句
思考: 文字交给 Cindy（oneshot 快速通道 / errand 派活）
播报: 本地 TTS（vits-melo 44.1kHz 中英双语）→ SoX 播放 → 蓝牙耳机
```

## 系统要求

| | Windows | macOS |
|---|---|---|
| 系统 | Windows 10 及以上（需自带 `tar.exe`） | macOS 12 及以上（Intel / Apple Silicon） |
| Cindy | ≥ 1.2.3 | ≥ 1.2.3 |
| SoX | 随包 `node/vendor/sox/sox.exe`，无需安装 | **需自行安装**（见下方） |
| 解压工具 | `C:\Windows\System32\tar.exe` | 系统自带 `/usr/bin/tar` |
| 语音模型 | 首次约 600MB，下载到 `%LOCALAPPDATA%\earbud-speaker\models` | 首次约 600MB，下载到 `~/earbud-speaker/models` |
| 音频设备 | 插件设置页可选麦克风 / 耳机；留空则用系统默认 | 同左 |

Linux 走与 macOS 相同的 SoX / 数据目录逻辑，但未作为正式支持平台测试。

## 安装使用

### 1. 导入插件

双击导入 `earbud-speaker-x.y.z.cindy`（或从源码用 Cindy 的 `ghost_forge_pack` 打包后再导入）。

### 2. 安装依赖（仅 macOS）

Windows 跳过本步。macOS 需要 SoX 才能录音和播报：

```bash
brew install sox
```

装好后在终端确认能找到命令：

```bash
which sox
sox --version
```

常见路径：Apple Silicon 为 `/opt/homebrew/bin/sox`，Intel 为 `/usr/local/bin/sox`。插件会从 `PATH` 以及这两处查找。找不到时面板会停在「已停止」，并提示 `brew install sox`。

若尚未安装 Homebrew：<https://brew.sh>

### 3. 下载语音模型

打开插件面板 → 点「下载语音模型」（约 600MB，仅首次）。

- Windows：`%LOCALAPPDATA%\earbud-speaker\models`
- macOS：`~/earbud-speaker/models`

下载失败可在面板重试；解压失败会保留压缩包，不必重新下。

### 4. 选择输入 / 输出设备

打开 Cindy 侧边栏该插件的 **设置页**，在「输入设备」和「输出设备」里选这副蓝牙耳机的麦克风和扬声器，保存即可。留空则使用系统默认设备。插拔耳机后点「刷新设备」。

同时请授予 Cindy 麦克风权限，否则选了设备也录不上音：

**Windows**

1. 设置 → 隐私和安全性 → 麦克风：允许 Cindy
2. 可选：任务栏声音图标 → 声音设置，确认耳机已连接

**macOS**

1. 系统设置 → 隐私与安全性 → 麦克风：允许 Cindy
2. 建议先在「语音备忘录」里试一下耳机麦，确认系统层能录上音

蓝牙耳机若同时走通话（HFP）模式，麦克风会被独占，唤醒词监听会暂停；日常请用立体声 / A2DP 播放，需要提问时再说唤醒词。

### 5. 开始使用

1. 点「开始聆听」
2. 对耳机说「嘿Cindy」（或设置里换过的唤醒词）
3. 听到"嘀"后说出问题
4. 停顿约 0.8 秒 → 等 Cindy 思考并播报

缺少 SoX 或打不开麦克风时，插件会停止聆听并弹出错误，而不会假装仍在待命。

可用一段含唤醒词的录音自测，不必对着麦克风说：面板点「选择音频测唤醒词」，或让 Agent 调用 `speaker_control` 的 `action=test_wake` 并传入本机 `filePath`。只跑 KWS，不走对话。

## 设置项

| 设置 | 说明 |
|---|---|
| 唤醒词 | 嘿Cindy / 你好Cindy / 小Cindy（也可选嘿辛蒂等中文词） |
| 播报音量 | 0.2x ~ 2x |
| 输入设备 | 麦克风；可刷新列表，留空 = 系统默认输入 |
| 输出设备 | 耳机 / 扬声器；留空 = 系统默认输出 |
| 快速通道 | 简单问题走轻量模型（默认开），关闭后全部开完整会话 |
| 自动聆听 | Cindy 启动后自动开始监听唤醒词 |

## 源码结构

```
├── ghost.json          # 插件清单（schemaVersion 3）
├── main.js             # 电子脑：worker RPC 编排 + 对话触发 + 面板广播
├── panel.html/css/js   # 停靠面板：状态机显示 / 模型下载 / 问答记录
├── settings.html/js    # 设置页：唤醒词 / 音量 / 输入输出设备 / 自动启动
└── node/
    ├── worker.cjs      # 音频核心：录音 → 唤醒 → 听写 → TTS → 播放状态机
    ├── sherpa/         # sherpa-onnx 1.13.6 WASM 引擎（15MB）
    └── vendor/sox/     # SoX v14.4.2 Windows 随包（2.6MB）；macOS 用系统 sox
```

## 已知限制

- 耳机通话时唤醒词监听自动暂停（蓝牙 HFP 麦克风独占）
- 语音模型仅支持中文普通话为主、英文为辅
- 首次加载引擎约 2~5 秒；唤醒后识别期间 CPU 约占一核
- macOS 不随包 SoX，未安装时无法录音/播放
- Linux 未正式支持

## License

Apache-2.0（与 sherpa-onnx 一致）
