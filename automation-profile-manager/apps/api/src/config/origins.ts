/**
 * Resolve CORS allowed origins from env (deploy: set APP_URL once).
 * Precedence: WEB_ORIGIN → APP_URL → NEXTAUTH_URL → localhost (dev only).
 */
export function resolveCorsOrigins(): string[] {
  const fromList = (raw?: string) =>
    (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        try {
          return new URL(s).origin;
        } catch {
          return s.replace(/\/$/, "");
        }
      });

  const explicit = fromList(process.env.WEB_ORIGIN);
  if (explicit.length) return [...new Set(explicit)];

  const single = process.env.APP_URL || process.env.NEXTAUTH_URL;
  if (single?.trim()) {
    try {
      const origin = new URL(single.trim()).origin;
      // Dev: luôn cho phép cả localhost lẫn APP_URL (LAN) để máy khác cùng Wi‑Fi vào được
      if (process.env.NODE_ENV !== "production") {
        return [
          ...new Set([
            origin,
            "http://localhost:3000",
            "http://127.0.0.1:3000",
          ]),
        ];
      }
      return [origin];
    } catch {
      return [single.trim().replace(/\/$/, "")];
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[security] Set APP_URL (or WEB_ORIGIN / NEXTAUTH_URL) for CORS in production",
    );
  }

  return ["http://localhost:3000", "http://127.0.0.1:3000"];
}
