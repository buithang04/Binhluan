/**
 * Xếp hàng LOGIN cho mọi hồ sơ + theo dõi kết quả READY/UNREADY.
 * Usage: node scripts/verify-all-profiles.mjs
 */
const API = process.env.APM_API_URL || "http://127.0.0.1:4000/api";
const ADMIN_EMAIL = process.env.APM_ADMIN_EMAIL || "admin@apm.local";
const ADMIN_PASSWORD = process.env.APM_ADMIN_PASSWORD || "Admin@123";

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || res.statusText);
  return data;
}

async function main() {
  const login = await api("/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, service: true },
  });
  const token = login.accessToken;
  if (!token) throw new Error("Login failed");

  const verify = await api("/profiles/verify-all-sessions", {
    method: "POST",
    token,
    body: {},
  });
  console.log(verify.message || `Enqueued ${verify.enqueued}/${verify.total}`);

  const deadline = Date.now() + 60 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const accounts = await api("/accounts", { token });
    const busy = accounts.filter(
      (a) =>
        a.profile &&
        ["QUEUED", "RUNNING"].includes((a.profile.status || "").toUpperCase()),
    );
    const ready = accounts.filter((a) => a.status === "READY");
    const unready = accounts.filter((a) => a.status !== "READY" && a.profile);
    console.log(
      `[${new Date().toLocaleTimeString("vi-VN")}] READY=${ready.length} UNREADY=${unready.length} đang chạy=${busy.length}`,
    );
    if (!busy.length) break;
  }

  const accounts = await api("/accounts", { token });
  const withProfile = accounts.filter((a) => a.profile);
  console.log("\n=== Kết quả ===");
  for (const a of withProfile.sort(
    (x, y) => (x.profile?.browserIndex ?? 0) - (y.profile?.browserIndex ?? 0),
  )) {
    const idx = a.profile?.browserIndex ?? "?";
    const st = a.status === "READY" ? "READY ✓" : `UNREADY (${a.loginIssue || "—"})`;
    console.log(`#${idx} ${a.email} → ${st}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
