import "server-only";

import { prisma } from "@/lib/prisma";

/** SystemSetting — tạm dừng enqueue tự động (loop/cron), không chặn Đăng tay. */
export const REVIEW_AUTO_DISPATCH_PAUSED_KEY = "review_auto_dispatch_paused";

let cache: { paused: boolean; at: number } | null = null;
const CACHE_MS = 2_000;

export async function isReviewAutoDispatchPaused(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.paused;

  const row = await prisma.systemSetting.findUnique({
    where: { key: REVIEW_AUTO_DISPATCH_PAUSED_KEY },
  });
  const paused = row?.value === "1" || row?.value === "true";
  cache = { paused, at: now };
  return paused;
}

export async function setReviewAutoDispatchPaused(
  paused: boolean,
): Promise<{ paused: boolean }> {
  await prisma.systemSetting.upsert({
    where: { key: REVIEW_AUTO_DISPATCH_PAUSED_KEY },
    create: { key: REVIEW_AUTO_DISPATCH_PAUSED_KEY, value: paused ? "1" : "0" },
    update: { value: paused ? "1" : "0" },
  });
  cache = { paused, at: Date.now() };
  return { paused };
}

/** Xóa cache sau khi đổi trạng thái từ API (đồng bộ giữa instance). */
export function invalidateReviewAutoDispatchCache() {
  cache = null;
}
