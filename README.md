# 耳机智能音箱 (cindy-speaker-box)

把蓝牙耳机变成智能音箱的 [Cindy](https://github.com/makecindy/cindy) 插件。

说唤醒词（默认「嘿辛蒂」）→ 听到"嘀"声后说出问题 → 停顿一下 → Cindy 思考后把口语化答案通过耳机播报回来。每个问题在 Cindy 侧边栏都有独立会话，可以随时回看完整回答。

## 特性

- **全离线语音链路**：唤醒词检测、语音识别、语音合成全部本地运行（[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WASM），无需任何 API key，语音数据不出本机
- **Cindy 派活 / 快速通道双链路**：简单问题走 Cindy 快速通道（几秒回），复杂问题自动转 errand 派活（Agent 可动用工具）
- **口语化播报**：答案强制精简为 3~5 句口语（中文数字读法、无 markdown），适合"听"
- **随包运行时**：sherpa-onnx WASM 引擎 + SoX 音频工具随插件分发，用户无需安装任何依赖

## 工作原理

```
待命: SoX 录音(16k) → KWS 唤醒词检测（silero zipformer）
唤醒: "嘀"提示音 → 流式 ASR 听写（zipformer int8）+ silero VAD 静音截句
思考: 文字交给 Cindy（oneshot 快速通道 / errand 派活）
播报: 本地 TTS（vits-melo 44.1kHz 中英双语）→ SoX 播放 → 蓝牙耳机
```

## 安装使用

1. 双击导入 `earbud-speaker-x.y.z.cindy`（或从源码 `ghost_forge_pack` 打包）
2. 打开插件面板 → 点「下载语音模型」（约 300MB，仅首次，存放在 `%LOCALAPPDATA%\earbud-speaker\models`）
3. Windows 声音设置里把蓝牙耳机设为默认输出 + 默认麦克风
4. 点「开始聆听」→ 对耳机说「嘿辛蒂」→ 说问题 → 停顿 → 等播报

## 设置项

| 设置 | 说明 |
|---|---|
| 唤醒词 | 嘿辛蒂 / 你好辛蒂 / 小辛蒂 / 嘿小辛 / 你好小辛 |
| 播报音量 | 0.2x ~ 2x |
| 快速通道 | 简单问题走轻量模型（默认开），关闭后全部开完整会话 |
| 自动聆听 | Cindy 启动后自动开始监听唤醒词 |

## 源码结构

```
├── ghost.json          # 插件清单（schemaVersion 3）
├── main.js             # 电子脑：worker RPC 编排 + 对话触发 + 面板广播
├── panel.html/css/js   # 停靠面板：状态机显示 / 模型下载 / 问答记录
├── settings.html/js    # 设置页：唤醒词 / 音量 / 自动启动
└── node/
    ├── worker.cjs      # 音频核心：录音 → 唤醒 → 听写 → TTS → 播放状态机
    ├── sherpa/         # sherpa-onnx 1.13.6 WASM 引擎（15MB）
    └── vendor/sox/     # SoX v14.4.2（2.6MB）
```

## 已知限制

- 耳机通话时唤醒词监听自动暂停（蓝牙 HFP 麦克风独占）
- 语音模型仅支持中文普通话为主、英文为辅
- 首次加载引擎约 2~5 秒；唤醒后识别期间 CPU 约占一核

## License

Apache-2.0（与 sherpa-onnx 一致）
