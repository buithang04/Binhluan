import "server-only";

import { prisma } from "@/lib/prisma";

const REPLANNABLE = ["PENDING", "FAILED"] as const;
/** Chỉ sửa mail trùng trên slot chưa/ không còn đăng — không đụng bài đang chạy hoặc đã xong. */
const DEDUPE_STATUSES = ["PENDING", "FAILED"] as const;

/**
 * Gỡ mail trùng — giữ lần xuất hiện đầu (sortOrder nhỏ); chỉ gỡ bài PENDING/FAILED trùng.
 */
export async function repairDuplicatePlanAssignments(planId: string): Promise<number> {
  const rows = await prisma.reviewAssignment.findMany({
    where: {
      planId,
      apmProfileId: { not: null },
    },
    orderBy: { sortOrder: "asc" },
    select: { id: true, apmProfileId: true, status: true },
  });

  const seen = new Set<string>();
  const toClear: string[] = [];

  for (const row of rows) {
    const pid = row.apmProfileId!;
    if (!seen.has(pid)) {
      seen.add(pid);
      continue;
    }
    if ((DEDUPE_STATUSES as readonly string[]).includes(row.status)) {
      toClear.push(row.id);
    }
  }

  if (!toClear.length) return 0;

  await prisma.reviewAssignment.updateMany({
    where: { id: { in: toClear } },
    data: {
      apmProfileId: null,
      profileEmail: null,
      error: null,
    },
  });

  return toClear.length;
}

/** Số bài PENDING/FAILED bị trùng mail (sẽ bị gỡ khi repair). */
export async function countDuplicatePlanProfiles(planId: string): Promise<number> {
  const rows = await prisma.reviewAssignment.findMany({
    where: {
      planId,
      apmProfileId: { not: null },
    },
    orderBy: { sortOrder: "asc" },
    select: { apmProfileId: true, status: true },
  });
  const seen = new Set<string>();
  let dupes = 0;
  for (const row of rows) {
    const pid = row.apmProfileId!;
    if (seen.has(pid)) {
      if ((DEDUPE_STATUSES as readonly string[]).includes(row.status)) dupes++;
    } else {
      seen.add(pid);
    }
  }
  return dupes;
}

export { REPLANNABLE };
