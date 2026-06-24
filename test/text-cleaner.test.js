import assert from "node:assert/strict";
import test from "node:test";

import { chunkText } from "../src/utils/text-cleaner.js";
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
