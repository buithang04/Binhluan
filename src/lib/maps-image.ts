/**
 * Chuẩn ảnh Google Maps / Business Profile:
 * - Format: JPG/PNG (WebP → chuyển JPEG khi chuẩn hóa)
 * - Size: 10KB–5MB
 * - Độ phân giải: tối thiểu 250×250, khuyến nghị ≥720×720
 * - Cạnh dài tối đa ~2048px (ảnh quá to hay upload fail trên Maps)
 */

export const MAPS_IMAGE_MIN_BYTES = 10 * 1024;
export const MAPS_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MAPS_IMAGE_MIN_EDGE = 250;
export const MAPS_IMAGE_TARGET_EDGE = 720;
export const MAPS_IMAGE_MAX_EDGE = 2048;

export const MAPS_IMAGE_HINT =
  `Ảnh Maps: tối thiểu ${MAPS_IMAGE_MIN_EDGE}×${MAPS_IMAGE_MIN_EDGE}px (khuyến nghị ${MAPS_IMAGE_TARGET_EDGE}px), tối đa ${MAPS_IMAGE_MAX_EDGE}px/cạnh, dung lượng ${Math.round(MAPS_IMAGE_MIN_BYTES / 1024)}KB–${MAPS_IMAGE_MAX_BYTES / 1024 / 1024}MB`;

export type MapsImageCheck = {
  ok: boolean;
  width: number;
  height: number;
  sizeBytes: number;
  error?: string;
  needsResize: boolean;
};

export function checkMapsImageMeta(
  width: number,
  height: number,
  sizeBytes: number,
): MapsImageCheck {
  const minEdge = Math.min(width, height);
  const maxEdge = Math.max(width, height);
  if (!width || !height) {
    return {
      ok: false,
      width,
      height,
      sizeBytes,
      needsResize: false,
      error: "Không đọc được kích thước ảnh",
    };
  }
  if (minEdge < MAPS_IMAGE_MIN_EDGE) {
    return {
      ok: false,
      width,
      height,
      sizeBytes,
      needsResize: false,
      error: `Ảnh quá nhỏ (${width}×${height}px). Maps cần tối thiểu ${MAPS_IMAGE_MIN_EDGE}×${MAPS_IMAGE_MIN_EDGE}px`,
    };
  }
  if (sizeBytes > 0 && sizeBytes < MAPS_IMAGE_MIN_BYTES) {
    return {
      ok: false,
      width,
      height,
      sizeBytes,
      needsResize: true,
      error: `Ảnh quá nhẹ (<${Math.round(MAPS_IMAGE_MIN_BYTES / 1024)}KB) — Maps có thể từ chối`,
    };
  }
  const needsResize =
    maxEdge > MAPS_IMAGE_MAX_EDGE ||
    minEdge < MAPS_IMAGE_TARGET_EDGE ||
    sizeBytes > MAPS_IMAGE_MAX_BYTES;
  if (sizeBytes > MAPS_IMAGE_MAX_BYTES && maxEdge <= MAPS_IMAGE_MAX_EDGE) {
    return {
      ok: true,
      width,
      height,
      sizeBytes,
      needsResize: true,
    };
  }
  return { ok: true, width, height, sizeBytes, needsResize };
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Không đọc được ảnh"));
    img.src = src;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality);
  });
}

/** Chuẩn hóa ảnh trước khi upload thư viện — resize/nén đạt chuẩn Maps. */
export async function prepareMapsImageFile(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    throw new Error("File không phải ảnh");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(objectUrl);
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    const pre = checkMapsImageMeta(w0, h0, file.size);
    if (!pre.ok && !pre.needsResize) {
      throw new Error(pre.error || "Ảnh không đạt chuẩn Maps");
    }
    if (pre.ok && !pre.needsResize && file.size <= MAPS_IMAGE_MAX_BYTES) {
      // Đủ chuẩn — giữ nguyên (trừ WebP → JPEG cho Maps ổn định hơn)
      if (file.type === "image/jpeg" || file.type === "image/png") {
        return file;
      }
    }

    let scale = 1;
    const maxEdge = Math.max(w0, h0);
    const minEdge = Math.min(w0, h0);
    if (maxEdge > MAPS_IMAGE_MAX_EDGE) {
      scale = MAPS_IMAGE_MAX_EDGE / maxEdge;
    } else if (minEdge < MAPS_IMAGE_TARGET_EDGE) {
      scale = MAPS_IMAGE_TARGET_EDGE / minEdge;
      // Không phóng quá mức làm cạnh dài > MAX
      if (maxEdge * scale > MAPS_IMAGE_MAX_EDGE) {
        scale = MAPS_IMAGE_MAX_EDGE / maxEdge;
      }
    }

    const tw = Math.max(1, Math.round(w0 * scale));
    const th = Math.max(1, Math.round(h0 * scale));
    if (Math.min(tw, th) < MAPS_IMAGE_MIN_EDGE) {
      throw new Error(
        `Ảnh quá nhỏ (${w0}×${h0}px). Maps cần tối thiểu ${MAPS_IMAGE_MIN_EDGE}×${MAPS_IMAGE_MIN_EDGE}px`,
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Không xử lý được ảnh (canvas)");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, tw, th);

    const base = file.name.replace(/\.[^.]+$/, "") || "maps-photo";
    let quality = 0.9;
    let blob: Blob | null = null;
    for (let i = 0; i < 8; i++) {
      blob = await canvasToBlob(canvas, "image/jpeg", quality);
      if (!blob) break;
      if (blob.size <= MAPS_IMAGE_MAX_BYTES && blob.size >= MAPS_IMAGE_MIN_BYTES) {
        break;
      }
      if (blob.size > MAPS_IMAGE_MAX_BYTES) {
        quality = Math.max(0.45, quality - 0.1);
        continue;
      }
      // Quá nhẹ — tăng quality
      if (blob.size < MAPS_IMAGE_MIN_BYTES && quality < 0.95) {
        quality = Math.min(0.95, quality + 0.05);
        continue;
      }
      break;
    }
    if (!blob) throw new Error("Không xuất được ảnh JPEG");
    if (blob.size > MAPS_IMAGE_MAX_BYTES) {
      throw new Error(
        `Ảnh vẫn >${MAPS_IMAGE_MAX_BYTES / 1024 / 1024}MB sau khi nén — chọn ảnh khác`,
      );
    }

    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
