import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { compareSync, hashSync } from "bcryptjs";

const ALGO = "aes-256-gcm";

function keyFromEnv(raw?: string): Buffer {
  const value = raw || process.env.ENCRYPTION_KEY || "";
  if (!value) {
    throw new Error("ENCRYPTION_KEY is required");
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  return createHash("sha256").update(value).digest();
}

export function encryptSecret(plain: string, encryptionKey?: string): Uint8Array {
  const key = keyFromEnv(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, tag, enc]));
}

export function decryptSecret(
  payload: Uint8Array | Buffer,
  encryptionKey?: string,
): string {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const key = keyFromEnv(encryptionKey);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

const BCRYPT_ROUNDS = 10;

/** bcrypt ($2…) — supports legacy salt$hash via verifyPassword. */
export function hashPassword(password: string): string {
  return hashSync(password, BCRYPT_ROUNDS);
}

/** Supports APM salt$hash and legacy CRM bcrypt ($2…). */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  if (stored.startsWith("$2")) {
    return compareSync(password, stored);
  }
  const [salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const next = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return next === hash;
}
