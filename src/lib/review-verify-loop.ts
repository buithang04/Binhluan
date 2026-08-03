import "server-only";

import { vnCalendarDateString } from "@/lib/review-schedule";

declare global {
  // eslint-disable-next-line no-var
  var __reviewVerifyLoopStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __reviewVerifyLastRunYmd: string | undefined;
}

const VN_TZ = "Asia/Ho_Chi_Minh";

function vnHour(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: VN_TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? -1);
}

/** 0h–2h sáng (VN): 00:00–01:59 */
function isNightlyVerifyWindow(now = new Date()): boolean {
  const h = vnHour(now);
  return h >= 0 && h < 2;
}

type VerifyBatchJson = {
  ok?: boolean;
  checked?: number;
  projects?: number;
  summary?: Record<string, number>;
  errors?: string[];
  message?: string;
};

/**
 * Gọi route cron nội bộ — tránh import puppeteer/review-verify-batch vào instrumentation.
 */
async function runNightlyVerifyBatch(): Promise<VerifyBatchJson> {
  const secret = process.env.REVIEW_CRON_SECRET;
  if (!secret) {
    throw new Error("REVIEW_CRON_SECRET is not configured");
  }
  const port = process.env.PORT || "3000";
  const base =
    process.env.REVIEW_VERIFY_SELF_URL?.replace(/\/$/, "") ||
    `http://127.0.0.1:${port}`;
  const url = `${base}/api/cron/review-verify?secret=${encodeURIComponent(secret)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "x-cron-secret": secret },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`cron review-verify HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as VerifyBatchJson;
}

/**
 * Tự quét bài COMPLETED xem review còn trên Maps (0h–2h sáng VN, 1 lần/ngày).
 * Khởi động cùng Next.js qua instrumentation.ts — không cần cron ngoài.
 */
export function startReviewVerifyLoop() {
  if (process.env.DISABLE_REVIEW_VERIFY_LOOP === "1") {
    console.log("[review-verify] disabled (DISABLE_REVIEW_VERIFY_LOOP=1)");
    return;
  }
  if (globalThis.__reviewVerifyLoopStarted) return;
  globalThis.__reviewVerifyLoopStarted = true;

  const pollMs = Math.max(60_000, Number(process.env.REVIEW_VERIFY_POLL_MS || 5 * 60_000));

  const tick = async () => {
    if (!isNightlyVerifyWindow()) return;

    const today = vnCalendarDateString();
    if (globalThis.__reviewVerifyLastRunYmd === today) return;

    try {
      console.log(`[review-verify] nightly scan start (${today} VN 0h–2h)`);
      const result = await runNightlyVerifyBatch();
      globalThis.__reviewVerifyLastRunYmd = today;
      console.log(
        `[review-verify] done: ${result.checked ?? 0} bài, ${result.projects ?? 0} dự án`,
        result.summary,
      );
      if (result.errors?.length) {
        console.warn(
          `[review-verify] ${result.errors.length} lỗi:`,
          result.errors.slice(0, 3),
        );
      }
    } catch (e) {
      console.error("[review-verify] nightly scan failed", e);
    }
  };

  setInterval(() => void tick(), pollMs);
  setTimeout(() => void tick(), 45_000);
  console.log(
    `[review-verify] auto-started with web (poll ${pollMs / 1000}s, window 0h–2h VN, 1 lần/ngày)`,
  );
}
