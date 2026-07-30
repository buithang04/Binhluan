import "server-only";
import sharp from "sharp";
import { imageSize } from "image-size";
import {
  MAPS_IMAGE_MAX_BYTES,
  MAPS_IMAGE_MAX_EDGE,
  MAPS_IMAGE_MIN_BYTES,
  MAPS_IMAGE_MIN_EDGE,
  MAPS_IMAGE_TARGET_EDGE,
  checkMapsImageMeta,
} from "@/lib/maps-image";

export type NormalizedMapsImage = {
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png";
  ext: "jpg" | "png";
  width: number;
  height: number;
  sizeBytes: number;
  changed: boolean;
};

/** Đọc kích thước từ buffer (không decode full). */
export function readImageSize(buffer: Buffer): { width: number; height: number } {
  const dim = imageSize(buffer);
  return { width: dim.width || 0, height: dim.height || 0 };
}

function computeTargetSize(width: number, height: number): { w: number; h: number } {
  const maxEdge = Math.max(width, height);
  const minEdge = Math.min(width, height);
  let scale = 1;
  if (maxEdge > MAPS_IMAGE_MAX_EDGE) {
    scale = MAPS_IMAGE_MAX_EDGE / maxEdge;
  } else if (minEdge < MAPS_IMAGE_TARGET_EDGE) {
    scale = MAPS_IMAGE_TARGET_EDGE / minEdge;
    if (maxEdge * scale > MAPS_IMAGE_MAX_EDGE) {
      scale = MAPS_IMAGE_MAX_EDGE / maxEdge;
    }
  }
  return {
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Chuẩn hóa ảnh server-side khi lưu thư viện:
 * - Reject quá nhỏ (<250px)
 * - Resize nếu quá to / dưới 720px cạnh ngắn
 * - Nén về ≤5MB
 */
export async function normalizeMapsImageBuffer(
  input: Buffer,
  mimeHint?: string,
): Promise<NormalizedMapsImage> {
  const meta0 = await sharp(input, { failOn: "none" }).metadata();
  const w0 = meta0.width || readImageSize(input).width;
  const h0 = meta0.height || readImageSize(input).height;
  const pre = checkMapsImageMeta(w0, h0, input.length);
  if (Math.min(w0, h0) < MAPS_IMAGE_MIN_EDGE) {
    throw new Error(
      pre.error ||
        `Ảnh quá nhỏ (${w0}×${h0}px). Maps cần tối thiểu ${MAPS_IMAGE_MIN_EDGE}×${MAPS_IMAGE_MIN_EDGE}px`,
    );
  }

  const { w: targetW, h: targetH } = computeTargetSize(w0, h0);
  const sizeOk =
    input.length >= MAPS_IMAGE_MIN_BYTES && input.length <= MAPS_IMAGE_MAX_BYTES;
  const dimOk = targetW === w0 && targetH === h0;
  if (
    dimOk &&
    sizeOk &&
    (mimeHint === "image/jpeg" || mimeHint === "image/png")
  ) {
    return {
      buffer: input,
      mimeType: mimeHint,
      ext: mimeHint === "image/png" ? "png" : "jpg",
      width: w0,
      height: h0,
      sizeBytes: input.length,
      changed: false,
    };
  }

  let quality = 88;
  let out = await sharp(input, { failOn: "none" })
    .rotate()
    .resize(targetW, targetH, { fit: "fill" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

  for (let i = 0; i < 6 && out.length > MAPS_IMAGE_MAX_BYTES; i++) {
    quality = Math.max(45, quality - 10);
    out = await sharp(input, { failOn: "none" })
      .rotate()
      .resize(targetW, targetH, { fit: "fill" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }
  if (out.length > MAPS_IMAGE_MAX_BYTES) {
    throw new Error(`Ảnh vẫn >${MAPS_IMAGE_MAX_BYTES / 1024 / 1024}MB sau khi nén`);
  }
  if (out.length < MAPS_IMAGE_MIN_BYTES) {
    out = await sharp(input, { failOn: "none" })
      .rotate()
      .resize(targetW, targetH, { fit: "fill" })
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer();
  }

  const finalMeta = await sharp(out).metadata();
  return {
    buffer: out,
    mimeType: "image/jpeg",
    ext: "jpg",
    width: finalMeta.width || targetW,
    height: finalMeta.height || targetH,
    sizeBytes: out.length,
    changed: true,
  };
}
