/**
 * Mở Chrome (focus hoặc LOGIN) cho hồ sơ READY — đủ điều kiện gán kế hoạch review.
 * Usage: node scripts/open-plan-eligible-profiles.mjs
 */
const API = process.env.APM_API_URL || "http://127.0.0.1:4000/api";
const ADMIN_EMAIL = process.env.APM_ADMIN_EMAIL || "admin@apm.local";
const ADMIN_PASSWORD = process.env.APM_ADMIN_PASSWORD || "Admin@123";
const DELAY_MS = Math.max(500, Number(process.env.OPEN_PROFILE_DELAY_MS || 2500));

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPlanEligible(account) {
  if (!account?.profile) return false;
  const p = account.profile;
  if (p.status === "DISABLED" || p.status === "ERROR") return false;
  if (account.status !== "READY") return false;
  if (p.status !== "READY") return false;
  if (account.loginIssue) return false;
  if (["QUEUED", "RUNNING"].includes(p.status)) return false;
  const lease = p.leaseUntil ? new Date(p.leaseUntil).getTime() : 0;
  if (lease > Date.now()) return false;
  return true;
}

async function waitForApi(maxMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      await fetch(`${API}/auth/login`, { method: "OPTIONS" }).catch(() => undefined);
      const res = await fetch(`${API.replace(/\/api$/, "")}/api/stats/overview`, {
        headers: { Authorization: "Bearer x" },
      }).catch(() => null);
      if (res && (res.status === 401 || res.ok)) return;
    } catch {
      /* retry */
    }
    await sleep(3000);
  }
  throw new Error("API chưa sẵn sàng sau restart");
}

async function main() {
  console.log("→ Đợi API…");
  await waitForApi();

  const login = await api("/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, service: true },
  });
  const token = login.accessToken;
  if (!token) throw new Error("Login failed");

  const accounts = await api("/accounts", { token });
  const eligible = accounts
    .filter(isPlanEligible)
    .sort((a, b) => (a.profile?.browserIndex ?? 0) - (b.profile?.browserIndex ?? 0));

  console.log(`→ ${eligible.length} hồ sơ READY (đủ điều kiện lập kế hoạch)`);

  let ok = 0;
  let fail = 0;
  for (const a of eligible) {
    const id = a.profile.id;
    const idx = a.profile.browserIndex;
    try {
      const out = await api(`/profiles/${id}/open-browser`, {
        method: "POST",
        token,
        body: {},
      });
      ok++;
      console.log(
        `#${idx} ${a.email} → ${out.action || "ok"}${out.resumed ? " (reuse Chrome)" : ""}`,
      );
    } catch (e) {
      fail++;
      console.warn(`#${idx} ${a.email} → lỗi: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nXong: ${ok} mở/focus, ${fail} lỗi (worker xử lý tuần tự trong queue)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
