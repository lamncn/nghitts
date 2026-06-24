<script setup>
import { ref, onMounted, onUnmounted, computed } from "vue";
import {
  DownloadIcon,
  PauseIcon,
  PlayIcon,
  CopyIcon,
  CheckIcon,
} from "lucide-vue-next";
import TextStatistics from "../components/TextStatistics.vue";
import SpeedControl from "../components/SpeedControl.vue";
import AudioChunk from "../components/AudioChunk.vue";
import ModelSelector from "../components/ModelSelector.vue";
import DemoTable from "../components/DemoTable.vue";
import { fetchAvailableModels } from "../utils/model-detector.js";
import { addEntry } from "../utils/history-store.js";
import { DEFAULT_MODEL } from "../config.js";
import { VI_TTS_MODEL_LABELS } from "../config/vi-models.js";

// State variables
const text = ref(
  "Con đang quán chiếu con là một cây hoa bồ công anh. Mỗi ngày con phơi những cánh lá của con trong không gian và tiếp thu tất cả những mầu nhiệm của sự sống. Cũng như các loài sinh vật khác, con dự tính cho sự tiếp nối đẹp đẽ của mình. Mỗi mùa xuân con làm ra nhiều bông hoa màu vàng, mỗi ngày những bông hoa đó lớn lên, nở ra rực rỡ",
);
const lastGeneration = ref(null);
const isPlaying = ref(false);
const currentChunkIndex = ref(-1);
const speed = ref(1);
const copied = ref(false);
const status = ref("idle");
const error = ref(null);
const worker = ref(null);
const voices = ref(null);
const selectedVoice = ref(0);
const chunks = ref([]);
const result = ref(null);
const availableModels = ref([]);
const selectedModel = ref("None");
const modelsLoading = ref(false);
const loadingProgress = ref(0);
const embedMode =
  new URLSearchParams(window.location.search).get("embed") === "1";

// Flutter WebView bridge state. Only one synthesis request is accepted at a time
// because the current worker protocol does not attach IDs to generated messages.
const BRIDGE_VERSION = 3;
const BRIDGE_AUDIO_CHUNK_BYTES = 64 * 1024;
const BRIDGE_ACK_TIMEOUT_MS = 30_000;
const bridgeEventLog = [];
let bridgeApi = null;
let pendingBridgeRequest = null;
let activeBridgeTransfer = null;
let bridgeOperationEpoch = 0;

// Computed properties
const processed = computed(() => {
  return (
    lastGeneration.value &&
    lastGeneration.value.text === text.value &&
    lastGeneration.value.speed === speed.value &&
    lastGeneration.value.voice === selectedVoice.value
  );
});

// Methods
const setSpeed = (newSpeed) => {
  speed.value = newSpeed;
};

function getBridgeState() {
  return {
    version: BRIDGE_VERSION,
    status: status.value,
    model: selectedModel.value === "None" ? null : selectedModel.value,
    availableModels: [...availableModels.value],
    voices: voices.value ? [...voices.value] : [],
    activeRequestId:
      pendingBridgeRequest?.requestId ||
      activeBridgeTransfer?.request.requestId ||
      null,
    phase: pendingBridgeRequest
      ? "generating"
      : activeBridgeTransfer
        ? "transferring"
        : null,
    busy: Boolean(pendingBridgeRequest) || Boolean(activeBridgeTransfer),
  };
}

function postBridgeEvent(event) {
  if (typeof window === "undefined") return;

  const payload = {
    source: "nghi-tts",
    version: BRIDGE_VERSION,
    timestamp: Date.now(),
    ...event,
  };

  document.documentElement.dataset.nghiTtsBridgeVersion =
    String(BRIDGE_VERSION);
  document.documentElement.dataset.nghiTtsEvent = payload.type;
  if (payload.model) {
    document.documentElement.dataset.nghiTtsModel = payload.model;
  }
  if (payload.type === "cancelled" && payload.requestId) {
    document.documentElement.dataset.nghiTtsCancelledRequest =
      payload.requestId;
  }

  // Keep lightweight diagnostics available to WebView clients. Audio payloads
  // are intentionally omitted from the log to avoid retaining duplicate data.
  const logEntry =
    payload.type === "audio_chunk"
      ? { ...payload, data: undefined, dataLength: payload.data?.length || 0 }
      : payload;
  bridgeEventLog.push(logEntry);
  if (bridgeEventLog.length > 100) bridgeEventLog.shift();

  try {
    if (typeof window.FlutterTTS?.postMessage === "function") {
      window.FlutterTTS.postMessage(JSON.stringify(payload));
    }
  } catch (err) {
    console.error("Failed to post TTS event to Flutter:", err);
  }

  window.dispatchEvent(new CustomEvent("nghi-tts-event", { detail: payload }));
}

function bridgeError(code, message, requestId = null) {
  postBridgeEvent({
    type: "error",
    code,
    message,
    requestId,
    model: selectedModel.value === "None" ? null : selectedModel.value,
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + blockSize),
    );
  }
  return btoa(binary);
}

function waitForFlutterAck(transfer, index) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (transfer.waitingForAck?.index !== index) return;
      transfer.waitingForAck = null;
      reject(new Error(`Flutter did not acknowledge audio chunk ${index}.`));
    }, BRIDGE_ACK_TIMEOUT_MS);

    transfer.waitingForAck = {
      index,
      resolve: () => {
        clearTimeout(timeoutId);
        transfer.waitingForAck = null;
        resolve();
      },
    };
  });
}

function acknowledgeAudioChunk(requestId, index) {
  const transfer = activeBridgeTransfer;
  const normalizedIndex = Number(index);
  if (!transfer || transfer.request.requestId !== String(requestId)) {
    return { accepted: false, code: "REQUEST_ID_MISMATCH" };
  }
  if (
    !transfer.waitingForAck ||
    transfer.waitingForAck.index !== normalizedIndex
  ) {
    return { accepted: false, code: "CHUNK_ACK_MISMATCH" };
  }

  transfer.waitingForAck.resolve();
  return {
    accepted: true,
    requestId: transfer.request.requestId,
    index: normalizedIndex,
  };
}

async function sendAudioToFlutter(audioBlob, request) {
  const transfer = {
    request,
    epoch: bridgeOperationEpoch,
    waitingForAck: null,
  };
  activeBridgeTransfer = transfer;

  const wasCancelled = () =>
    activeBridgeTransfer !== transfer ||
    transfer.epoch !== bridgeOperationEpoch;

  try {
    const sizeBytes = audioBlob.size;
    const totalChunks = Math.ceil(sizeBytes / BRIDGE_AUDIO_CHUNK_BYTES);
    const mimeType = audioBlob.type || "audio/wav";

    postBridgeEvent({
      type: "audio_start",
      requestId: request.requestId,
      model: request.model,
      mimeType,
      sizeBytes,
      totalChunks,
      fileName: `tts-${request.requestId}.wav`,
    });

    for (let index = 0; index < totalChunks; index += 1) {
      if (wasCancelled()) return;

      const start = index * BRIDGE_AUDIO_CHUNK_BYTES;
      const end = Math.min(start + BRIDGE_AUDIO_CHUNK_BYTES, sizeBytes);
      const bytes = new Uint8Array(
        await audioBlob.slice(start, end).arrayBuffer(),
      );
      if (wasCancelled()) return;

      const ackPromise = request.ackAudioChunks
        ? waitForFlutterAck(transfer, index)
        : null;
      postBridgeEvent({
        type: "audio_chunk",
        requestId: request.requestId,
        index,
        totalChunks,
        data: bytesToBase64(bytes),
      });
      if (ackPromise) {
        await ackPromise;
      } else {
        // Backwards compatibility for bridge v2 clients that do not advertise
        // ACK support. New Flutter clients always use the backpressured path.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    if (wasCancelled()) return;

    postBridgeEvent({
      type: "complete",
      requestId: request.requestId,
      model: request.model,
      mimeType,
      sizeBytes,
      totalChunks,
      fileName: `tts-${request.requestId}.wav`,
    });
  } catch (err) {
    if (wasCancelled()) return;
    console.error("Failed to transfer generated audio to Flutter:", err);
    bridgeError(
      "AUDIO_TRANSFER_FAILED",
      err?.message || String(err),
      request.requestId,
    );
  } finally {
    if (activeBridgeTransfer === transfer) {
      activeBridgeTransfer = null;
    }
  }
}

function loadBridgeModel(modelName) {
  const name = String(modelName || "").trim();
  if (!name) {
    bridgeError("INVALID_MODEL", "Model name is required.");
    return { accepted: false, code: "INVALID_MODEL" };
  }
  if (
    pendingBridgeRequest ||
    activeBridgeTransfer ||
    status.value === "generating"
  ) {
    bridgeError("BUSY", "TTS is currently generating audio.");
    return { accepted: false, code: "BUSY" };
  }
  if (!availableModels.value.includes(name)) {
    bridgeError("MODEL_NOT_FOUND", `Model "${name}" is not available.`);
    return { accepted: false, code: "MODEL_NOT_FOUND" };
  }
  if (name === selectedModel.value && status.value === "ready") {
    postBridgeEvent({
      type: "model_ready",
      model: name,
      voices: voices.value || [],
    });
    return { accepted: true, model: name, alreadyLoaded: true };
  }

  selectedModel.value = name;
  restartWorker(name);
  return { accepted: true, model: name, alreadyLoaded: false };
}

function startSynthesisJob({
  requestId,
  requestedText,
  normalizedVoice,
  normalizedSpeed,
  deliverToFlutter,
  autoPlay,
  ackAudioChunks = false,
}) {
  text.value = requestedText;
  speed.value = normalizedSpeed;
  selectedVoice.value = normalizedVoice;
  status.value = "generating";
  error.value = null;
  chunks.value = [];
  result.value = null;
  currentChunkIndex.value = autoPlay ? 0 : -1;
  isPlaying.value = autoPlay;

  const params = {
    text: requestedText,
    voice: normalizedVoice,
    speed: normalizedSpeed,
    requestId,
    deliverToFlutter,
  };
  lastGeneration.value = params;
  pendingBridgeRequest = {
    requestId,
    model: selectedModel.value,
    deliverToFlutter,
    ackAudioChunks,
  };

  postBridgeEvent({
    type: "generation_started",
    requestId,
    model: selectedModel.value,
    voice: normalizedVoice,
    speed: normalizedSpeed,
    client: deliverToFlutter ? "flutter" : "web",
  });
  worker.value.postMessage(params);
}

function synthesizeFromBridge(options = {}) {
  const requestedText =
    typeof options.text === "string" ? options.text.trim() : "";
  const requestId = String(
    options.requestId ||
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  if (!requestedText) {
    bridgeError("INVALID_TEXT", "Text is required.", requestId);
    return { accepted: false, code: "INVALID_TEXT", requestId };
  }
  if (!worker.value || status.value !== "ready") {
    bridgeError(
      "MODEL_NOT_READY",
      "Wait for the model_ready event before synthesizing.",
      requestId,
    );
    return { accepted: false, code: "MODEL_NOT_READY", requestId };
  }
  if (pendingBridgeRequest || activeBridgeTransfer) {
    bridgeError(
      "BUSY",
      "Another synthesis request is still running.",
      requestId,
    );
    return { accepted: false, code: "BUSY", requestId };
  }

  const requestedSpeed = Number(options.speed ?? 1);
  const normalizedSpeed = Number.isFinite(requestedSpeed)
    ? Math.min(2, Math.max(0.5, requestedSpeed))
    : 1;
  const requestedVoice = Number(options.voice ?? 0);
  const normalizedVoice =
    Number.isInteger(requestedVoice) && requestedVoice >= 0
      ? requestedVoice
      : 0;

  startSynthesisJob({
    requestId,
    requestedText,
    normalizedVoice,
    normalizedSpeed,
    deliverToFlutter: true,
    autoPlay: false,
    ackAudioChunks: options.ackAudioChunks === true,
  });

  return { accepted: true, requestId, model: selectedModel.value };
}

function stopBridge(rawOptions = {}) {
  const options =
    typeof rawOptions === "string"
      ? { requestId: rawOptions }
      : rawOptions || {};
  const requestedId =
    options.requestId == null ? null : String(options.requestId);
  const generationRequest = pendingBridgeRequest;
  const transfer = activeBridgeTransfer;
  const activeRequest = generationRequest || transfer?.request || null;

  if (!activeRequest) {
    const response = { accepted: false, code: "NO_ACTIVE_REQUEST" };
    postBridgeEvent({ type: "stop_ignored", code: response.code });
    return response;
  }

  if (requestedId && requestedId !== activeRequest.requestId) {
    const message = `Active request is "${activeRequest.requestId}", not "${requestedId}".`;
    bridgeError("REQUEST_ID_MISMATCH", message, requestedId);
    return {
      accepted: false,
      code: "REQUEST_ID_MISMATCH",
      activeRequestId: activeRequest.requestId,
    };
  }

  const phase = generationRequest ? "generating" : "transferring";
  const model = activeRequest.model;
  const shouldReloadModel =
    phase === "generating" && options.reloadModel !== false;

  // Invalidates any asynchronous audio transfer that may still be yielding
  // between chunks. The transfer checks both this epoch and object identity.
  bridgeOperationEpoch += 1;
  pendingBridgeRequest = null;
  activeBridgeTransfer = null;
  transfer?.waitingForAck?.resolve();

  isPlaying.value = false;
  currentChunkIndex.value = -1;
  chunks.value = [];
  result.value = null;
  lastGeneration.value = null;
  error.value = null;

  if (phase === "generating") {
    // ONNX Runtime does not provide a reliable abort for an in-flight
    // session.run(). Terminating the Worker is the immediate cancellation
    // boundary and also prevents old messages reaching the replacement Worker.
    if (worker.value) {
      if (worker.value._progressInterval) {
        clearInterval(worker.value._progressInterval);
      }
      worker.value.terminate();
      worker.value = null;
    }
    voices.value = null;
    status.value = shouldReloadModel ? "loading" : "idle";
  } else {
    // Audio has already been generated. Only stop the Flutter transfer and keep
    // the loaded model so a new request can start immediately.
    status.value = worker.value ? "ready" : "idle";
  }

  postBridgeEvent({
    type: "cancelled",
    requestId: activeRequest.requestId,
    model,
    phase,
    reloadingModel: shouldReloadModel,
    readyForNextRequest: phase === "transferring",
  });

  if (shouldReloadModel && model) {
    restartWorker(model);
  }

  return {
    accepted: true,
    requestId: activeRequest.requestId,
    phase,
    reloadingModel: shouldReloadModel,
  };
}

function installFlutterBridge() {
  if (typeof window === "undefined") return;

  bridgeApi = Object.freeze({
    version: BRIDGE_VERSION,
    getState: getBridgeState,
    getEvents: () => bridgeEventLog.map((event) => ({ ...event })),
    loadModel: loadBridgeModel,
    synthesize: synthesizeFromBridge,
    stop: stopBridge,
    ackAudioChunk: acknowledgeAudioChunk,
  });
  window.NghiTTS = bridgeApi;
  document.documentElement.dataset.nghiTtsBridge = "ready";
  document.documentElement.dataset.nghiTtsMethods =
    Object.keys(bridgeApi).join(",");

  postBridgeEvent({
    type: "bridge_ready",
    requestedModel: new URLSearchParams(window.location.search).get("model"),
  });
}

const restartWorker = (modelName = null) => {
  if (worker.value) {
    if (worker.value._progressInterval) {
      clearInterval(worker.value._progressInterval);
    }
    worker.value.terminate();
  }

  // Reset all audio and UI state
  status.value = "loading";
  loadingProgress.value = 0;
  voices.value = null;
  chunks.value = [];
  result.value = null;
  lastGeneration.value = null;
  isPlaying.value = false;
  currentChunkIndex.value = -1;
  error.value = null;

  // Simulate progress animation
  const progressInterval = setInterval(() => {
    if (loadingProgress.value < 90) {
      loadingProgress.value += Math.random() * 5;
      if (loadingProgress.value > 90) loadingProgress.value = 90;
    }
  }, 200);

  const nextWorker = new Worker(
    new URL("../workers/tts-worker.js", import.meta.url),
    {
      type: "module",
    },
  );
  worker.value = nextWorker;

  nextWorker.addEventListener("message", (event) => {
    if (worker.value === nextWorker) onMessageReceived(event);
  });
  nextWorker.addEventListener("error", (event) => {
    if (worker.value === nextWorker) onErrorReceived(event);
  });

  const modelToLoad = modelName || selectedModel.value;
  postBridgeEvent({ type: "model_loading", model: modelToLoad });
  nextWorker.postMessage({ type: "init", model: modelToLoad });

  nextWorker._progressInterval = progressInterval;
};

const setCurrentChunkIndex = (index) => {
  currentChunkIndex.value = index;
};

const setIsPlaying = (playing) => {
  isPlaying.value = playing;
};

const handleChunkEnd = () => {
  if (
    status.value !== "generating" &&
    currentChunkIndex.value === chunks.value.length - 1
  ) {
    isPlaying.value = false;
    currentChunkIndex.value = -1;
  } else {
    currentChunkIndex.value = currentChunkIndex.value + 1;
  }
};

const handlePlayPause = () => {
  if (status.value === "generating" && pendingBridgeRequest) {
    stopBridge({
      requestId: pendingBridgeRequest.requestId,
      reloadModel: true,
    });
    return;
  }

  if (!isPlaying.value && status.value === "ready" && !processed.value) {
    startSynthesisJob({
      requestId: `web-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      requestedText: text.value.trim(),
      normalizedVoice: selectedVoice.value,
      normalizedSpeed: speed.value,
      deliverToFlutter: false,
      autoPlay: true,
    });
    return;
  }
  if (currentChunkIndex.value === -1) {
    currentChunkIndex.value = 0;
  }
  isPlaying.value = !isPlaying.value;
};

const downloadAudio = () => {
  if (!result.value) return;
  const url = URL.createObjectURL(result.value);
  const link = document.createElement("a");
  link.href = url;
  link.download = "audio.wav";
  link.click();
  URL.revokeObjectURL(url);
};

const handleCopy = async () => {
  await navigator.clipboard.writeText(text.value);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 2000);
};

const handleDemoTextClick = (demoText) => {
  text.value = demoText;
};

const fetchModels = async (preferredModel = null) => {
  modelsLoading.value = true;
  try {
    const models = await fetchAvailableModels();
    availableModels.value = models;

    if (
      selectedModel.value &&
      selectedModel.value !== "None" &&
      !models.includes(selectedModel.value)
    ) {
      selectedModel.value = "None";
      if (worker.value) {
        worker.value.terminate();
        worker.value = null;
        status.value = "loading";
        voices.value = null;
      }
    }

    const requestedModel = String(preferredModel || "").trim();
    if (requestedModel) {
      if (!models.includes(requestedModel)) {
        selectedModel.value = "None";
        status.value = "error";
        error.value = `Requested model "${requestedModel}" is not available.`;
        bridgeError("MODEL_NOT_FOUND", error.value);
        return;
      }
      selectedModel.value = requestedModel;
      restartWorker(requestedModel);
      return;
    }

    // Flutter chooses a model through the bridge. Avoid downloading the web
    // default first when embed mode did not request a model in the URL.
    if (embedMode && !requestedModel) {
      status.value = "idle";
      return;
    }

    // Auto-load default model when entering the regular web page.
    if (selectedModel.value === "None" && models.length > 0) {
      const defaultModel =
        DEFAULT_MODEL.vi && models.includes(DEFAULT_MODEL.vi)
          ? DEFAULT_MODEL.vi
          : models[0];
      selectedModel.value = defaultModel;
      restartWorker(defaultModel);
    }
  } catch (err) {
    console.error("Failed to fetch models:", err);
    error.value = `Failed to load models: ${err.message}`;
  } finally {
    modelsLoading.value = false;
  }
};

const handleModelChange = (modelName) => {
  if (modelName !== selectedModel.value) {
    selectedModel.value = modelName;

    if (modelName === "None") {
      if (worker.value) {
        worker.value.terminate();
        worker.value = null;
      }
      status.value = "loading";
      voices.value = null;
      chunks.value = [];
      result.value = null;
      lastGeneration.value = null;
      isPlaying.value = false;
      currentChunkIndex.value = -1;
    } else {
      restartWorker(modelName);
    }
  }
};

// Worker message handlers
const onMessageReceived = ({ data }) => {
  switch (data.status) {
    case "ready":
      if (worker.value?._progressInterval) {
        clearInterval(worker.value._progressInterval);
      }
      loadingProgress.value = 100;
      status.value = "ready";
      voices.value = data.voices;
      postBridgeEvent({
        type: "model_ready",
        model: selectedModel.value,
        voices: data.voices || [],
      });
      setTimeout(() => {
        loadingProgress.value = 0;
      }, 300);
      break;
    case "error":
      if (worker.value?._progressInterval) {
        clearInterval(worker.value._progressInterval);
      }
      loadingProgress.value = 0;
      status.value = "error";
      error.value = data.data;
      if (pendingBridgeRequest) {
        bridgeError(
          "GENERATION_FAILED",
          data.data,
          pendingBridgeRequest.requestId,
        );
        pendingBridgeRequest = null;
      } else {
        bridgeError("MODEL_LOAD_FAILED", data.data);
      }
      break;
    case "stream":
      if (!pendingBridgeRequest?.deliverToFlutter) {
        chunks.value = [...chunks.value, data.chunk];
      }
      break;
    case "generation_progress":
      if (pendingBridgeRequest) {
        postBridgeEvent({
          type: "generation_progress",
          requestId: pendingBridgeRequest.requestId,
          currentChunk: data.currentChunk,
          totalChunks: data.totalChunks,
        });
      }
      break;
    case "complete":
      status.value = "ready";
      {
        const request = pendingBridgeRequest;
        pendingBridgeRequest = null;
        result.value = request?.deliverToFlutter ? null : data.audio;
        if (request?.deliverToFlutter && data.audio) {
          void sendAudioToFlutter(data.audio, request);
        } else if (request?.deliverToFlutter) {
          bridgeError(
            "EMPTY_AUDIO",
            "TTS completed without audio data.",
            request.requestId,
          );
        }
        // Flutter owns bridge-generated files, so do not also duplicate them in
        // the browser's IndexedDB history.
        if (
          (!request || !request.deliverToFlutter) &&
          data.audio &&
          lastGeneration.value &&
          selectedModel.value
        ) {
          addEntry({
            text: lastGeneration.value.text,
            voice: lastGeneration.value.voice,
            speed: lastGeneration.value.speed,
            model: selectedModel.value,
            lang: "vi",
            audio: data.audio,
          }).catch((err) => console.error("History save failed:", err));
        }
      }
      break;
    case "preview":
      if (data.audio) {
        const audioUrl = URL.createObjectURL(data.audio);
        const audio = new Audio(audioUrl);
        audio
          .play()
          .then(() => {
            setTimeout(() => URL.revokeObjectURL(audioUrl), 1000);
          })
          .catch((err) => console.error("Error playing preview:", err));
      }
      break;
  }
};

const onErrorReceived = (e) => {
  console.error("Worker error:", e);
  status.value = "error";
  error.value = e.message;
  if (pendingBridgeRequest) {
    bridgeError("WORKER_ERROR", e.message, pendingBridgeRequest.requestId);
    pendingBridgeRequest = null;
  } else {
    bridgeError("WORKER_ERROR", e.message);
  }
};

onMounted(async () => {
  const requestedModel = new URLSearchParams(window.location.search).get(
    "model",
  );
  await fetchModels(requestedModel);
  // bridge_ready means the model catalogue is now usable by loadModel().
  installFlutterBridge();
});

onUnmounted(() => {
  bridgeOperationEpoch += 1;
  activeBridgeTransfer = null;
  if (worker.value) {
    if (worker.value._progressInterval) {
      clearInterval(worker.value._progressInterval);
    }
    worker.value.terminate();
  }
  if (typeof window !== "undefined" && window.NghiTTS === bridgeApi) {
    delete window.NghiTTS;
  }
  pendingBridgeRequest = null;
});
</script>

<template>
  <div v-if="!embedMode">
    <!-- Main Card -->
    <div
      class="bg-white/70 dark:bg-gray-900/70 backdrop-blur-xl rounded-2xl shadow-xl border border-white/20 dark:border-gray-700/50 overflow-hidden"
    >
      <div class="p-6 pb-0 space-y-6">
        <!-- Text Input Section -->
        <div class="space-y-4">
          <div class="relative">
            <textarea
              v-model="text"
              placeholder="Type or paste your text here..."
              class="w-full min-h-[180px] text-lg leading-relaxed resize-y p-4 pt-8 rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 focus:border-purple-500 dark:focus:border-purple-400 focus:ring-0 transition-colors"
              :class="voices ? '' : 'text-muted-foreground'"
            ></textarea>
            <button
              class="absolute top-1 right-3 h-10 w-10 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center transition-colors"
              @click="handleCopy"
              :title="copied ? 'Copied!' : 'Copy text'"
            >
              <CheckIcon v-if="copied" class="h-4 w-4 text-green-500" />
              <CopyIcon v-else class="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          <div class="flex justify-end">
            <TextStatistics :text="text" />
          </div>
        </div>

        <!-- Controls Section -->
        <div class="space-y-4">
          <div v-if="availableModels.length > 0" class="flex items-center">
            <label
              class="text-sm font-medium text-gray-700 dark:text-gray-300 mr-2"
            >
              Model:
            </label>
            <ModelSelector
              :models="availableModels"
              :selected-model="selectedModel"
              :model-labels="VI_TTS_MODEL_LABELS"
              @model-change="handleModelChange"
            />
          </div>

          <div
            v-if="modelsLoading"
            class="flex items-center gap-2 text-muted-foreground text-sm"
          >
            <div
              class="animate-spin w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full"
            ></div>
            <span>Loading available models...</span>
          </div>

          <div v-if="voices" class="flex items-center">
            <SpeedControl :speed="speed" @speed-change="setSpeed" />
          </div>

          <div
            v-else-if="error"
            class="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm"
          >
            {{ error }}
          </div>
          <div
            v-else-if="selectedModel === 'None'"
            class="p-3 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg text-sm"
          >
            Please select a model to start using TTS
          </div>
          <div
            v-else-if="!voices && status === 'loading'"
            class="w-full flex items-center gap-3"
          >
            <span
              class="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap"
              >Loading model</span
            >
            <div
              class="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-6 overflow-hidden"
            >
              <div
                class="h-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all duration-300 ease-out flex items-center justify-end pr-2"
                :style="{ width: `${loadingProgress}%` }"
              >
                <span class="text-white text-xs font-semibold"
                  >{{ Math.round(loadingProgress) }}%</span
                >
              </div>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex flex-col sm:flex-row gap-3">
          <button
            class="flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold text-white transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:scale-100 disabled:opacity-50 disabled:cursor-not-allowed"
            :class="{
              'bg-gradient-to-r from-orange-500 to-orange-700 hover:from-orange-600 hover:to-orange-800 shadow-lg shadow-orange-500/25':
                isPlaying,
              'bg-blue-800 shadow-lg': !isPlaying,
            }"
            @click="handlePlayPause"
            :disabled="
              (status === 'ready' && !isPlaying && !text) ||
              (status !== 'ready' &&
                status !== 'generating' &&
                chunks.length === 0)
            "
          >
            <PauseIcon v-if="isPlaying" class="w-5 h-5" />
            <PlayIcon v-else class="w-5 h-5" />
            <span v-if="isPlaying">Pause</span>
            <span v-else>{{
              processed || status === "generating" ? "Play" : "Generate"
            }}</span>
          </button>

          <button
            class="flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:scale-100 disabled:opacity-50 disabled:cursor-not-allowed"
            @click="downloadAudio"
            :disabled="!result || status !== 'ready'"
          >
            <DownloadIcon class="w-4 h-4" />
            Download Audio
          </button>
        </div>

        <!-- Hidden Audio Chunks -->
        <div class="w-0 h-0 hidden">
          <AudioChunk
            v-if="chunks.length > 0"
            v-for="(chunk, index) in chunks"
            :key="index"
            :audio="chunk.audio"
            :active="currentChunkIndex === index"
            :playing="isPlaying"
            class="hidden"
            @start="() => setCurrentChunkIndex(index)"
            @pause="
              () => {
                if (currentChunkIndex === index) setIsPlaying(false);
              }
            "
            @end="handleChunkEnd"
          />
        </div>
      </div>
    </div>

    <!-- Demo Table -->
    <DemoTable @text-click="handleDemoTextClick" />
  </div>
</template>
