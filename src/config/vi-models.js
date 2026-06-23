/**
 * Vietnamese Piper models hosted on the public Cloudflare R2 custom domain.
 *
 * The model ID must match both object names:
 *   {id}.onnx
 *   {id}.onnx.json
 */

export const VI_TTS_R2_BASE_URL = (
  import.meta.env.VITE_VI_TTS_BASE_URL || "https://r2.booktoaudio.app/piper/vi"
).replace(/\/+$/, "");

/** Use R2 in production. Set VITE_USE_REMOTE_VI_TTS=true to test R2 in Vite dev. */
export const USE_REMOTE_VI_TTS =
  import.meta.env.PROD || import.meta.env.VITE_USE_REMOTE_VI_TTS === "true";

export const VI_TTS_MODELS = Object.freeze([
  { id: "banmai", label: "Ban Mai", enabled: true },
  { id: "chieuthanh", label: "Chiếu Thành", enabled: true },
  { id: "lacphi", label: "Lạc Phi", enabled: true },
  { id: "maiphuong", label: "Mai Phương", enabled: true },
  { id: "manhdung", label: "Mạnh Dũng", enabled: true },
  { id: "minhkhang", label: "Minh Khang", enabled: true },
  { id: "minhquang", label: "Minh Quang", enabled: true },
  { id: "minhthu", label: "Minh Thu", enabled: true },
  { id: "mytam2", label: "Mỹ Tâm 2", enabled: true },
  { id: "mytam2794", label: "Mỹ Tâm", enabled: true },
  { id: "ngochuyen", label: "Ngọc Huyền", enabled: true },
  { id: "ngochuyennew", label: "Ngọc Huyền (mới)", enabled: true },
  { id: "ngocngan3701", label: "Ngọc Ngạn", enabled: true },
  { id: "phuongtrang", label: "Phương Trang", enabled: true },
  { id: "thanhphuong2", label: "Thanh Phương", enabled: true },
  { id: "thientam", label: "Thiện Tâm", enabled: true },
  { id: "tranthanh3870", label: "Trấn Thành", enabled: true },
  { id: "vietthao3886", label: "Việt Thảo", enabled: true },
]);

export const VI_TTS_MODEL_IDS = Object.freeze(
  VI_TTS_MODELS.filter((model) => model.enabled).map((model) => model.id),
);

export const VI_TTS_MODEL_LABELS = Object.freeze(
  Object.fromEntries(VI_TTS_MODELS.map((model) => [model.id, model.label])),
);

export function getVietnameseModelUrl(modelName, suffix) {
  const fileName = `${encodeURIComponent(modelName)}${suffix}`;
  if (USE_REMOTE_VI_TTS) {
    return `${VI_TTS_R2_BASE_URL}/${fileName}`;
  }
  return `/api/model/${fileName}`;
}
