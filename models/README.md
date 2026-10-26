# Local models

Everything in this folder is optional at build time but required for the fully
offline mode. The app looks for these files automatically and starts them on
its own, so no external server has to be installed.

```
models/
├─ qwen2.5-1.5b-instruct-q4_k_m.gguf     LLM used for chat
├─ llama/
│  ├─ llama-server.exe                   OpenAI-compatible local server
│  └─ *.dll                              runtime libraries for llama-server
└─ tts/
   ├─ en_US-amy-medium.onnx              Piper voice model
   ├─ en_US-amy-medium.onnx.json         voice config (sample rate etc.)
   └─ piper/
      ├─ piper.exe                       speech synthesis
      └─ *.dll                           runtime libraries for piper
```

## How it is used

- On startup the app spawns `llama/llama-server.exe` with the GGUF in this
  folder and listens on `http://127.0.0.1:8137`. The process is hidden and is
  terminated again when the app quits.
- Chat requests use the normal OpenAI-compatible streaming API. When a reply
  would copy the previous line verbatim, the app asks once more with a
  "say it differently" nudge.
- `speak_local` sends a line to `piper.exe`, receives a WAV file and plays it
  through the lip-sync analyser. If Piper is missing the app falls back to the
  Web Speech voice (with a procedural mouth animation).
- If several GGUF files are present the app prefers the better quantisation
  (q5_k_m > q4_k_m > q4_0 > q3_k_m > q2_k) and ignores files under 32 MB.

## Adding another model

- LLM: drop another `.gguf` here. It is picked automatically by the ranking
  above.
- Voice: drop another `*.onnx` + `*.onnx.json` pair into `tts/`. The app uses
  the first `.onnx` it finds, so keep only one voice in that folder.
- For a packaged build, copy this `models` folder next to the installed
  executable. The app also searches the parent folders, which is why the
  development build finds `E:\Ei Model\models` automatically.
