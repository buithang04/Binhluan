import "server-only";

import { prisma } from "@/lib/prisma";
import { isMapsDeletedAssignment } from "@/lib/review-schedule";

const REPLANNABLE = ["PENDING", "FAILED"] as const;
/** Chỉ sửa mail trùng trên slot chưa/ không còn đăng — không đụng bài đang chạy hoặc đã xong. */
const DEDUPE_STATUSES = ["PENDING", "FAILED"] as const;

/**
 * Gỡ mail trùng — giữ lần xuất hiện đầu (sortOrder nhỏ); chỉ gỡ bài PENDING/FAILED trùng.
 * Bài đã xóa trên Maps không chiếm mail (được phép gán lại cho slot mới).
 */
export async function repairDuplicatePlanAssignments(planId: string): Promise<number> {
  const rows = await prisma.reviewAssignment.findMany({
    where: {
      planId,
      apmProfileId: { not: null },
    },
    orderBy: { sortOrder: "asc" },
    select: { id: true, apmProfileId: true, status: true, error: true },
  });

  const seen = new Set<string>();
  const toClear: string[] = [];

  for (const row of rows) {
    if (isMapsDeletedAssignment(row)) continue;
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
    select: { apmProfileId: true, status: true, error: true },
  });
  const seen = new Set<string>();
  let dupes = 0;
  for (const row of rows) {
    if (isMapsDeletedAssignment(row)) continue;
    const pid = row.apmProfileId!;
    if (seen.has(pid)) {
      if ((DEDUPE_STATUSES as readonly string[]).includes(row.status)) dupes++;
    } else {
      seen.add(pid);
    }
  }
  return dupes;
}

/**
 * Sắp lại sortOrder: Đã xóa Maps → COMPLETED/QUEUED/RUNNING → còn lại.
 * Sửa tình trạng # trùng / nhảy lung tung sau khi xóa + lập kế hoạch cũ.
 */
export async function repairMapsDeletedSortOrder(planId: string): Promise<boolean> {
  const rows = await prisma.reviewAssignment.findMany({
    where: { planId },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      sortOrder: true,
      status: true,
      error: true,
    },
  });
  if (!rows.length) return false;

  const deleted = rows.filter((a) => isMapsDeletedAssignment(a));
  const locked = rows.filter(
    (a) =>
      ["COMPLETED", "QUEUED", "RUNNING"].includes(a.status) &&
      !isMapsDeletedAssignment(a),
  );
  const rest = rows.filter(
    (a) =>
      !isMapsDeletedAssignment(a) &&
      !["COMPLETED", "QUEUED", "RUNNING"].includes(a.status),
  );
  const ordered = [...deleted, ...locked, ...rest];

  const sortOrders = new Set(rows.map((r) => r.sortOrder));
  let needs = sortOrders.size !== rows.length;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.sortOrder !== i) {
      needs = true;
      break;
    }
  }
  if (!needs && deleted.length > 0) {
    for (let i = 0; i < deleted.length; i++) {
      if (!isMapsDeletedAssignment(ordered[i]!)) {
        needs = true;
        break;
      }
    }
  }
  if (!needs) return false;

  await prisma.$transaction(
    ordered.map((row, i) =>
      prisma.reviewAssignment.update({
        where: { id: row.id },
        data: { sortOrder: i },
      }),
    ),
  );
  return true;
}

export { REPLANNABLE };
