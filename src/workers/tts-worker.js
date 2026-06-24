import { PiperTTS, TextSplitterStream } from "../lib/piper-tts.js";
import { getVietnameseModelUrl } from "../config/vi-models.js";
import { mergeAudioChunksToWav } from "../utils/wav.js";

let tts = null;

// Initialize the model
async function initializeModel(modelName = null) {
  try {
    // Default to the original model if no model name provided
    const defaultModel = "en_US-libritts_r-medium";
    const model = modelName || defaultModel;
    const modelPath = getVietnameseModelUrl(model, ".onnx");
    const configPath = getVietnameseModelUrl(model, ".onnx.json");

    tts = await PiperTTS.from_pretrained(modelPath, configPath);

    // Get available speakers
    const speakers = tts.getSpeakers();

    self.postMessage({ status: "ready", voices: speakers });
  } catch (e) {
    console.error("Error loading model:", e);
    self.postMessage({ status: "error", data: e.message });
  }
}

// Handle voice preview
async function handlePreview(text, voice, speed) {
  try {
    const streamer = new TextSplitterStream();
    await streamer.push(text);
    streamer.close();

    const speakerId = typeof voice === "number" ? voice : parseInt(voice) || 0;
    const lengthScale = 1.0 / (speed || 1.0);

    const stream = tts.stream(streamer, {
      speakerId,
      lengthScale,
    });

    // Get just the first chunk for preview
    for await (const { audio } of stream) {
      // Create and play preview audio
      const audioBlob = audio.toBlob();
      self.postMessage({ status: "preview", audio: audioBlob });
      break; // Only preview the first chunk
    }
  } catch (error) {
    console.error("Error generating preview:", error);
  }
}

// Listen for messages from the main thread
self.addEventListener("message", async (e) => {
  const {
    type,
    text,
    voice,
    speed,
    model,
    requestId,
    deliverToFlutter = false,
  } = e.data;

  // Handle initialization
  if (type === "init") {
    await initializeModel(model);
    return;
  }

  // Handle TTS generation
  if (!tts) {
    self.postMessage({ status: "error", data: "Model not initialized" });
    return;
  }

  // Handle voice preview
  if (type === "preview") {
    await handlePreview(text, voice, speed);
    return;
  }

  try {
    const streamer = new TextSplitterStream();
    await streamer.push(text);
    streamer.close();

    const speakerId = typeof voice === "number" ? voice : parseInt(voice) || 0;
    const lengthScale = 1.0 / (speed || 1.0);
    const stream = tts.stream(streamer, {
      speakerId,
      lengthScale,
    });
    const chunks = [];

    for await (const { text, audio } of stream) {
      if (!deliverToFlutter) {
        self.postMessage({
          status: "stream",
          chunk: {
            audio: audio.toBlob(),
            text,
          },
        });
      }
      chunks.push(audio);
    }

    const audio = chunks.length > 0 ? mergeAudioChunksToWav(chunks) : null;
    self.postMessage({ status: "complete", audio, requestId });
  } catch (error) {
    console.error("Error during TTS generation:", error);
    self.postMessage({ status: "error", data: error.message, requestId });
  }
});

// Note: Initialization now handled via init message from UI
