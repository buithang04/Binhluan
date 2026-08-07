import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import path from "path";
import { fetch } from "undici";
import sharp from "sharp";

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = /^https?:\/\//i;
/** Dưới ngưỡng này ảnh vỡ hẳn, không cứu được bằng phóng to. */
const MIN_ACCEPT_EDGE = 100;
/** Worker chuẩn hoá lại theo luật ảnh Maps (≥250px) — phóng dư để luôn qua. */
const TARGET_MIN_EDGE = 400;
const MAX_EDGE = 2048;

function detectImageExtension(buf: Buffer): ".jpg" | ".png" | ".webp" {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return ".jpg";
  }
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return ".png";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  throw new Error("File không phải ảnh JPG, PNG hoặc WebP hợp lệ");
}

function resolveAvatarDir() {
  const fromEnv = process.env.ACCOUNT_AVATAR_DIR || "./data/account-avatars";
  const dir = path.isAbsolute(fromEnv)
    ? fromEnv
    : path.resolve(process.cwd(), fromEnv);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

async function removeOldAccountAvatars(
  dir: string,
  accountId: string,
  keepPath: string,
) {
  try {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(dir);
    for (const name of entries) {
      const full = path.join(dir, name);
      if (name.startsWith(`${accountId}-`) && full !== keepPath) {
        await unlink(full).catch(() => undefined);
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Chuẩn hoá về JPEG đủ lớn cho Google Personal info.
 * Ảnh nhỏ được phóng to thay vì loại — chỉ chặn ảnh vỡ hẳn hoặc file hỏng.
 */
async function normalizeAvatarBuffer(data: Buffer): Promise<Buffer> {
  const metadata = await sharp(data, { failOn: "error" }).metadata().catch(() => null);
  if (!metadata) throw new Error("File ảnh hỏng hoặc không đọc được");

  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const shortEdge = Math.min(width, height);
  if (!shortEdge) throw new Error("File ảnh hỏng hoặc không đọc được");
  if (shortEdge < MIN_ACCEPT_EDGE) {
    throw new Error(
      `Ảnh quá nhỏ (${width}×${height}px), cần tối thiểu ${MIN_ACCEPT_EDGE}px mỗi chiều`,
    );
  }

  const scale = Math.min(
    Math.max(1, TARGET_MIN_EDGE / shortEdge),
    MAX_EDGE / Math.max(width, height),
  );
  const pipeline = sharp(data, { failOn: "error" }).rotate();
  const resized =
    scale === 1
      ? pipeline.resize({
          width: MAX_EDGE,
          height: MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
      : pipeline.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          fit: "fill",
        });

  try {
    return await resized
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new Error("File ảnh hỏng hoặc không đọc được");
  }
}

/** Lưu file ảnh người dùng upload trực tiếp sau khi kiểm tra magic bytes. */
export async function cacheUploadedAccountAvatar(
  accountId: string,
  data: Buffer,
): Promise<string> {
  if (data.length < 512) throw new Error("File avatar quá nhỏ");
  if (data.length > MAX_BYTES) throw new Error("File avatar > 8MB");

  detectImageExtension(data);
  const normalized = await normalizeAvatarBuffer(data);

  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const dir = resolveAvatarDir();
  const outPath = path.join(dir, `${accountId}-${hash}.jpg`);
  await writeFile(outPath, normalized);
  await removeOldAccountAvatars(dir, accountId, outPath);
  return outPath;
}

/** Tải avatar URL → cache local theo accountId. Trả về path tuyệt đối. */
export async function cacheAccountAvatarFromUrl(
  accountId: string,
  avatarUrl: string,
): Promise<string> {
  const url = String(avatarUrl || "").trim();
  if (!url || !ALLOWED.test(url)) {
    throw new Error("URL avatar không hợp lệ (cần http/https)");
  }

  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BinhluanAvatar/1.0)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Tải avatar thất bại HTTP ${res.status}`);
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct && !ct.startsWith("image/")) {
    throw new Error(`URL không phải ảnh (content-type: ${ct || "?"})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 512) {
    throw new Error("File avatar quá nhỏ");
  }
  if (buf.length > MAX_BYTES) {
    throw new Error("File avatar > 8MB");
  }

  const normalized = await normalizeAvatarBuffer(buf);
  const dir = resolveAvatarDir();
  const hash = createHash("md5").update(url).digest("hex").slice(0, 8);
  const outPath = path.join(dir, `${accountId}-${hash}.jpg`);

  await writeFile(outPath, normalized);
  await removeOldAccountAvatars(dir, accountId, outPath);
  return outPath;
}

export function resolveAvatarStorageDir() {
  return resolveAvatarDir();
}
