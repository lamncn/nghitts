# Flutter WebView integration

The Vietnamese TTS page exposes a small JavaScript bridge for Flutter WebView.
Inference still runs inside the page's Web Worker; Flutter only selects a model,
starts synthesis, and receives the generated WAV.

## Load a model

Register the `FlutterTTS` JavaScript channel before loading the page, then open:

```text
https://<your-domain>/?embed=1&model=ngocngan3701
```

- `embed=1` keeps the Vue page mounted but hides the website UI.
- `model` must be the model file name without `.onnx`.
- Wait for the `model_ready` event before requesting synthesis.

The page emits JSON strings through `window.FlutterTTS.postMessage(...)`.

## JavaScript API

```js
window.NghiTTS.getState();
window.NghiTTS.loadModel("ngocngan3701");
window.NghiTTS.synthesize({
  requestId: "request-123",
  text: "Xin chao, day la ban thu giong noi.",
  voice: 0,
  speed: 1.0,
});
window.NghiTTS.stop({
  requestId: "request-123",
  reloadModel: true,
});
```

`synthesize` returns an object with `accepted`, `requestId`, and `model`.
Only one synthesis request is accepted at a time. Speed is clamped to `0.5-2.0`.

## Stop a request

```js
window.NghiTTS.stop({
  requestId: "request-123",
  reloadModel: true,
});
```

`requestId` is optional. When supplied, it protects a newer request from being
cancelled accidentally. A mismatched ID returns `REQUEST_ID_MISMATCH`.

Cancellation depends on the current phase:

- `generating`: the Web Worker is terminated immediately. ONNX Runtime cannot
  reliably abort an in-flight `session.run()`, so the same model is reloaded by
  default. Wait for the next `model_ready` event before starting another job.
- `transferring`: audio generation has already finished. Only the remaining
  Base64 chunks are cancelled, while the loaded model is kept. A new job can be
  submitted immediately after the `cancelled` event.

Set `reloadModel: false` to terminate a generating Worker without loading the
model again. Call `loadModel()` before the next synthesis in that case.

Flutter must discard all collected chunks for a request when it receives its
`cancelled` event. Audio already playing in Flutter must be stopped separately
by the Flutter audio player.

## Events

Every event contains `source: "nghi-tts"`, `version`, `timestamp`, and `type`.

```text
bridge_ready
model_loading
model_ready
generation_started
cancelled
stop_ignored
audio_start
audio_chunk (repeated)
complete
error
```

`audio_start` contains `sizeBytes`, `totalChunks`, `mimeType`, and `fileName`.
Each `audio_chunk` contains:

```json
{
  "type": "audio_chunk",
  "requestId": "request-123",
  "index": 0,
  "totalChunks": 2,
  "data": "<base64>"
}
```

Store chunks by `index`, base64-decode them, concatenate the decoded bytes, and
write the result as the `.wav` file named by the `complete` event.

Errors use one of these codes:

```text
INVALID_MODEL
MODEL_NOT_FOUND
MODEL_LOAD_FAILED
MODEL_NOT_READY
INVALID_TEXT
BUSY
NO_ACTIVE_REQUEST
REQUEST_ID_MISMATCH
GENERATION_FAILED
WORKER_ERROR
EMPTY_AUDIO
AUDIO_TRANSFER_FAILED
```

For diagnostics, `window.NghiTTS.getEvents()` returns the latest lightweight
events. Audio base64 data is deliberately omitted from this diagnostic log.
