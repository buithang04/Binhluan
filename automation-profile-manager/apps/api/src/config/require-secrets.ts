/** Fail fast when required secrets are missing (production-safe defaults). */
export function requireSecrets(): void {
  const isProd = process.env.NODE_ENV === "production";
  const required = ["JWT_ACCESS_SECRET", "INTERNAL_API_TOKEN", "ENCRYPTION_KEY"];
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    const msg = `[security] Missing required env: ${missing.join(", ")}`;
    if (isProd) throw new Error(msg);
    console.warn(`${msg} — using dev-only fallbacks`);
  }
}

export function jwtSecret(): string {
  const s = process.env.JWT_ACCESS_SECRET?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_ACCESS_SECRET is required in production");
  }
  return "dev-access-secret-local-only";
}

export function internalToken(): string {
  const s = process.env.INTERNAL_API_TOKEN?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("INTERNAL_API_TOKEN is required in production");
  }
  return "dev-internal-token-local-only";
}
