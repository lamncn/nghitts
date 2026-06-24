import assert from "node:assert/strict";
import test from "node:test";

import { PiperTTS } from "../src/lib/piper-tts.js";

test("phonemesToIds drops chunks unsupported by the model", async () => {
  const tts = new PiperTTS({
    phoneme_id_map: {
      "^": [1],
      _: [0],
      $: [2],
      a: [3],
    },
  });

  assert.deepEqual(await tts.phonemesToIds([["x"]]), []);
  assert.equal((await tts.phonemesToIds([["a"]])).length, 5);
});
