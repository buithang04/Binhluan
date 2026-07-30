import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { mkdtemp, unlink, writeFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";

const MIN_BYTES = 10 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
const MIN_EDGE = 250;
const TARGET_EDGE = 720;
const MAX_EDGE = 2048;

const TEMP_ROOT = path.join(tmpdir(), "binhluan-maps-photos");

function ensureTempRoot() {
  if (!existsSync(TEMP_ROOT)) mkdirSync(TEMP_ROOT, { recursive: true });
}

/**
 * Chuẩn hóa ảnh trước khi upload Maps.
 * Trả về path dùng được (có thể là file tạm) + danh sách file tạm cần xóa sau.
 */
export async function prepareMapsPhotoForUpload(
  filePath: string,
): Promise<{ path: string; tempPaths: string[] }> {
  if (!existsSync(filePath)) {
    throw new Error(`Thiếu file ảnh: ${filePath}`);
  }

  const input = sharp(filePath, { failOn: "none" }).rotate();
  const meta = await input.metadata();
  const w0 = meta.width || 0;
  const h0 = meta.height || 0;
  if (Math.min(w0, h0) < MIN_EDGE) {
    throw new Error(
      `Ảnh quá nhỏ (${w0}×${h0}px) — Maps cần ≥${MIN_EDGE}px. Upload lại ảnh lớn hơn trong thư viện dự án.`,
    );
  }

  const maxEdge = Math.max(w0, h0);
  const minEdge = Math.min(w0, h0);
  let scale = 1;
  if (maxEdge > MAX_EDGE) scale = MAX_EDGE / maxEdge;
  else if (minEdge < TARGET_EDGE) {
    scale = TARGET_EDGE / minEdge;
    if (maxEdge * scale > MAX_EDGE) scale = MAX_EDGE / maxEdge;
  }
  const tw = Math.max(1, Math.round(w0 * scale));
  const th = Math.max(1, Math.round(h0 * scale));

  const { size } = await import("fs/promises").then((m) => m.stat(filePath));
  const alreadyOk =
    scale === 1 &&
    size >= MIN_BYTES &&
    size <= MAX_BYTES &&
    /\.(jpe?g|png)$/i.test(filePath);

  if (alreadyOk) {
    return { path: filePath, tempPaths: [] };
  }

  ensureTempRoot();
  const hash = createHash("md5").update(filePath).digest("hex").slice(0, 10);
  const outDir = await mkdtemp(path.join(TEMP_ROOT, `${hash}-`));
  const outPath = path.join(outDir, "maps-ready.jpg");

  let quality = 88;
  let buf = await sharp(filePath, { failOn: "none" })
    .rotate()
    .resize(tw, th, { fit: "fill" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  for (let i = 0; i < 6 && buf.length > MAX_BYTES; i++) {
    quality = Math.max(45, quality - 10);
    buf = await sharp(filePath, { failOn: "none" })
      .rotate()
      .resize(tw, th, { fit: "fill" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }
  if (buf.length > MAX_BYTES) {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Ảnh vẫn >5MB sau nén — không upload Maps được`);
  }
  await writeFile(outPath, buf);
  console.log(
    `[maps-review] chuẩn hóa ảnh ${path.basename(filePath)} → ${tw}×${th} ${Math.round(buf.length / 1024)}KB`,
  );
  return { path: outPath, tempPaths: [outPath, outDir] };
}

export async function cleanupMapsPhotoTemps(tempPaths: string[]) {
  const dirs = new Set<string>();
  for (const p of tempPaths) {
    try {
      if (!p) continue;
      const st = await import("fs/promises").then((m) => m.stat(p)).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) dirs.add(p);
      else {
        await unlink(p).catch(() => undefined);
        dirs.add(path.dirname(p));
      }
    } catch {
      /* ignore */
    }
  }
  for (const d of dirs) {
    if (d.startsWith(TEMP_ROOT)) {
      await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Dọn thư mục temp cũ (>1 ngày). */
export async function sweepStaleMapsPhotoTemps() {
  ensureTempRoot();
  try {
    const entries = await readdir(TEMP_ROOT, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const e of entries) {
      const full = path.join(TEMP_ROOT, e.name);
      const st = await import("fs/promises").then((m) => m.stat(full)).catch(() => null);
      if (!st || st.mtimeMs > cutoff) continue;
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}
