export function mergeAudioChunksToWav(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;

  const sampleRate = chunks[0].sampling_rate;
  const sampleCount = chunks.reduce(
    (sum, chunk) => sum + chunk.audio.length,
    0,
  );
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let maxPeak = 1e-9;
  for (const chunk of chunks) {
    if (chunk.sampling_rate !== sampleRate) {
      throw new Error("Cannot merge audio chunks with different sample rates");
    }
    for (const sample of chunk.audio) {
      maxPeak = Math.max(maxPeak, Math.abs(sample));
    }
  }
  const gain = Math.min(1, 1 / maxPeak);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk.audio) {
      const normalized = Math.max(-1, Math.min(1, sample * gain));
      view.setInt16(
        offset,
        normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff,
        true,
      );
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
