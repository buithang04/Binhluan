import "server-only";

import {
  getPausedProjectIds,
  isProjectAutoDispatchPaused,
} from "@/lib/review-dispatch-control";

declare global {
  // eslint-disable-next-line no-var
  var __apmReviewDispatchStarted: boolean | undefined;
}

/**
 * Auto-enqueue bài PENDING đang trong cửa sổ lịch đăng (không dump quá hạn).
 * FAILED / quá hạn → lập lại lịch hoặc Đăng tay. Mỗi tick: min(proxy, WORKER_CONCURRENCY) bài.
 * Pause theo từng dự án — không dừng toàn hệ thống.
 */
export function startReviewDispatchLoop() {
  if (process.env.DISABLE_REVIEW_DISPATCHER === "1") return;
  if (globalThis.__apmReviewDispatchStarted) return;
  globalThis.__apmReviewDispatchStarted = true;

  const intervalMs = Number(process.env.REVIEW_DISPATCH_INTERVAL_MS || 30_000);
  const loginWaitMs = Number(process.env.REVIEW_LOGIN_WAIT_INTERVAL_MS || 8_000);
  const proxyWaitMs = Number(process.env.REVIEW_PROXY_WAIT_INTERVAL_MS || 5_000);

  const tick = async () => {
    try {
      const { dispatchDueReviewAssignments } = await import("@/lib/review-dispatch");
      const result = await dispatchDueReviewAssignments();
      if (result.dispatched > 0) {
        console.log(`[review-dispatch] enqueued ${result.dispatched} assignment(s)`);
      }
      if (result.errors.length > 0) {
        console.warn(
          `[review-dispatch] ${result.errors.length} error(s): ${result.errors.slice(0, 3).join(" · ")}`,
        );
      }
    } catch (e) {
      console.error("[review-dispatch] tick failed", e);
    }
  };

  // Tự đăng tiếp các bài đang chờ login xong (account chuyển READY) — không cần bấm lại.
  const loginTick = async () => {
    try {
      const { drainLoginWaits } = await import("@/lib/review-login-wait");
      const waits = drainLoginWaits();
      if (waits.length === 0) return;
      const paused = await getPausedProjectIds();
      const { dispatchDueReviewAssignments } = await import("@/lib/review-dispatch");
      for (const w of waits) {
        if (w.projectId && paused.has(w.projectId)) continue;
        if (w.projectId && (await isProjectAutoDispatchPaused(w.projectId))) continue;
        const result = await dispatchDueReviewAssignments({
          assignmentId: w.assignmentId,
          projectId: w.projectId,
          autoContinue: true,
        });
        if (result.dispatched > 0) {
          console.log(
            `[review-dispatch] login xong → tự đăng bài ${w.assignmentId}`,
          );
        }
      }
    } catch (e) {
      console.error("[review-dispatch] login-wait tick failed", e);
    }
  };

  // Chờ proxy — poll nhanh (5s) để đăng ngay khi lock/cooldown hết.
  const proxyTick = async () => {
    try {
      const { drainProxyWaits, hasProxyWaits } = await import("@/lib/review-proxy-wait");
      if (!hasProxyWaits()) return;
      const paused = await getPausedProjectIds();
      const { dispatchDueReviewAssignments } = await import("@/lib/review-dispatch");
      const waits = drainProxyWaits();
      const doneKeys = new Set<string>();
      for (const w of waits) {
        if (w.projectId && paused.has(w.projectId)) continue;
        const key = w.assignmentId ?? w.projectId ?? "__global__";
        if (doneKeys.has(key)) continue;
        doneKeys.add(key);
        const result = await dispatchDueReviewAssignments({
          assignmentId: w.assignmentId,
          projectId: w.projectId,
        });
        if (result.dispatched > 0) {
          console.log(
            `[review-dispatch] proxy rảnh → enqueue ${result.dispatched} bài (${key})`,
          );
        }
      }
    } catch (e) {
      console.error("[review-dispatch] proxy-wait tick failed", e);
    }
  };

  // Trễ lần đầu để tránh HMR/restart vừa boot đã spam enqueue
  setTimeout(() => void tick(), 15_000);
  setInterval(() => void tick(), intervalMs);
  setInterval(() => void loginTick(), loginWaitMs);
  setInterval(() => void proxyTick(), proxyWaitMs);
  console.log(
    `[review-dispatch] auto-post loop every ${intervalMs / 1000}s (RUNNING) + auto-continue login every ${loginWaitMs / 1000}s + proxy-wait every ${proxyWaitMs / 1000}s`,
  );
}
