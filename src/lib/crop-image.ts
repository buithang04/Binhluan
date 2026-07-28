export type PixelCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const TO_RADIANS = Math.PI / 180;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality = 0.92,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/** Xuất ảnh đã crop / xoay / lật thành Blob. */
export async function getEditedImageBlob(
  imageSrc: string,
  pixelCrop: PixelCrop,
  rotation = 0,
  flip = { horizontal: false, vertical: false },
  mimeType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
): Promise<Blob | null> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const rotRad = rotation * TO_RADIANS;
  const bBox = {
    width:
      Math.abs(Math.cos(rotRad) * image.width) +
      Math.abs(Math.sin(rotRad) * image.height),
    height:
      Math.abs(Math.sin(rotRad) * image.width) +
      Math.abs(Math.cos(rotRad) * image.height),
  };

  canvas.width = bBox.width;
  canvas.height = bBox.height;

  ctx.translate(bBox.width / 2, bBox.height / 2);
  ctx.rotate(rotRad);
  ctx.scale(flip.horizontal ? -1 : 1, flip.vertical ? -1 : 1);
  ctx.translate(-image.width / 2, -image.height / 2);
  ctx.drawImage(image, 0, 0);

  const cropped = document.createElement("canvas");
  const croppedCtx = cropped.getContext("2d");
  if (!croppedCtx) return null;

  cropped.width = pixelCrop.width;
  cropped.height = pixelCrop.height;
  croppedCtx.drawImage(
    canvas,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height,
  );

  return canvasToBlob(cropped, mimeType);
}

export function blobToFile(blob: Blob, fileName: string): File {
  return new File([blob], fileName, { type: blob.type });
}

export function guessMimeType(fileName?: string): "image/jpeg" | "image/png" | "image/webp" {
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export function editedFileName(original?: string): string {
  const base = original?.replace(/\.[^.]+$/, "") || "edited";
  const ext = original?.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (ext === "png" || ext === "webp") return `${base}.${ext}`;
  return `${base}.jpg`;
}
