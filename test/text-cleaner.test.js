import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  cleanTextForTTS,
  chunkText,
  normalizePunctuationSpacing,
  processTextForTTS,
} from "../src/utils/text-cleaner.js";
import { mergeAudioChunksToWav } from "../src/utils/wav.js";

test("chunkText caps long sentences for mobile inference", async () => {
  const text = Array.from({ length: 600 }, () => "tiếng").join(" ");
  const chunks = await chunkText(text);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length > 0));
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
});

test("chunkText preserves normal sentence boundaries", async () => {
  const chunks = await chunkText("Câu thứ nhất. Câu thứ hai!");

  assert.deepEqual(chunks, ["Câu thứ nhất.", "Câu thứ hai!"]);
});

test("punctuation spacing separates sentences without flattening newlines", async () => {
  const normalized = normalizePunctuationSpacing(
    "thiếu niên.anh   trai...Em gái!\n  Được chứ?được.",
  );

  assert.equal(
    normalized,
    "thiếu niên. anh trai... Em gái!\nĐược chứ? được.",
  );
  assert.deepEqual(await chunkText(normalized), [
    "thiếu niên.",
    "anh trai...",
    "Em gái!",
    "Được chứ?",
    "được.",
  ]);
});

test("full preprocessing keeps line boundaries and prevents joined words", async () => {
  const [foreignWords, acronyms] = await Promise.all([
    readFile(new URL("../public/non-vietnamese-words.csv", import.meta.url)),
    readFile(new URL("../public/acronyms.csv", import.meta.url)),
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/non-vietnamese-words.csv")) {
      return new Response(foreignWords, { status: 200 });
    }
    if (url.endsWith("/acronyms.csv")) {
      return new Response(acronyms, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const input = "dòng một\nanh—em\nxin…chào\nanh(em)\nanh😀em";
    assert.equal(
      cleanTextForTTS(input),
      "dòng một\nanh em\nxin...chào\nanh em\nanh em",
    );

    const processed = await processTextForTTS(input);
    assert.equal(
      processed,
      "dòng một\nanh em\nxin. chào\nanh em\nanh em",
    );
    assert.deepEqual(await chunkText(processed), [
      "dòng một.",
      "anh em.",
      "xin.",
      "chào.",
      "anh em.",
      "anh em.",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mergeAudioChunksToWav writes a valid PCM WAV", async () => {
  const blob = mergeAudioChunksToWav([
    { sampling_rate: 22050, audio: new Float32Array([0, 0.5]) },
    { sampling_rate: 22050, audio: new Float32Array([-0.5, 1]) },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE");
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(bytes.length, 52);
});
