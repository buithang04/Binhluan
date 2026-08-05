import "server-only";

import { prisma } from "@/lib/prisma";

/** Legacy — pause mọi dự án (đã bỏ; clear khi đọc/ghi per-project). */
export const REVIEW_AUTO_DISPATCH_PAUSED_KEY = "review_auto_dispatch_paused";

const KEY_PREFIX = "review_auto_dispatch_paused:";

function projectPauseKey(projectId: string) {
  return `${KEY_PREFIX}${projectId}`;
}

let cache: Map<string, { paused: boolean; at: number }> | null = null;
let pausedIdsCache: { ids: Set<string>; at: number } | null = null;
const CACHE_MS = 2_000;

function getCacheMap() {
  if (!cache) cache = new Map();
  return cache;
}

async function clearLegacyGlobalPause() {
  await prisma.systemSetting
    .deleteMany({ where: { key: REVIEW_AUTO_DISPATCH_PAUSED_KEY } })
    .catch(() => undefined);
}

export async function isProjectAutoDispatchPaused(
  projectId: string,
): Promise<boolean> {
  const now = Date.now();
  const map = getCacheMap();
  const hit = map.get(projectId);
  if (hit && now - hit.at < CACHE_MS) return hit.paused;

  const row = await prisma.systemSetting.findUnique({
    where: { key: projectPauseKey(projectId) },
  });
  const paused = row?.value === "1" || row?.value === "true";
  map.set(projectId, { paused, at: now });
  return paused;
}

/** @deprecated Dùng isProjectAutoDispatchPaused — giữ để tương thích import cũ. */
export async function isReviewAutoDispatchPaused(
  projectId?: string,
): Promise<boolean> {
  if (projectId) return isProjectAutoDispatchPaused(projectId);
  // Không còn pause toàn cục: loop luôn chạy, lọc theo dự án.
  return false;
}

export async function getPausedProjectIds(): Promise<Set<string>> {
  const now = Date.now();
  if (pausedIdsCache && now - pausedIdsCache.at < CACHE_MS) {
    return pausedIdsCache.ids;
  }

  const rows = await prisma.systemSetting.findMany({
    where: {
      key: { startsWith: KEY_PREFIX },
      value: { in: ["1", "true"] },
    },
    select: { key: true },
  });

  const ids = new Set(
    rows
      .map((r) => r.key.slice(KEY_PREFIX.length))
      .filter((id) => id.length > 0),
  );
  pausedIdsCache = { ids, at: now };
  return ids;
}

export async function setProjectAutoDispatchPaused(
  projectId: string,
  paused: boolean,
): Promise<{ paused: boolean }> {
  const key = projectPauseKey(projectId);
  if (paused) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: "1" },
      update: { value: "1" },
    });
  } else {
    await prisma.systemSetting.deleteMany({ where: { key } });
  }
  await clearLegacyGlobalPause();
  invalidateReviewAutoDispatchCache();
  getCacheMap().set(projectId, { paused, at: Date.now() });
  return { paused };
}

/** @deprecated */
export async function setReviewAutoDispatchPaused(
  paused: boolean,
  projectId?: string,
): Promise<{ paused: boolean }> {
  if (!projectId) {
    throw new Error("Cần projectId — pause theo từng dự án");
  }
  return setProjectAutoDispatchPaused(projectId, paused);
}

export function invalidateReviewAutoDispatchCache() {
  cache = null;
  pausedIdsCache = null;
}
