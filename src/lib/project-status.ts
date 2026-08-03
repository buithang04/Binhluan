import type { ProjectStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Trạng thái hiển thị trên header dự án — ưu tiên lịch đăng nếu đang chạy. */
export function resolveProjectDisplayStatus(
  projectStatus: ProjectStatus | string,
  reviewPlanStatus?: string | null,
): string {
  switch (reviewPlanStatus) {
    case "RUNNING":
      return "ACTIVE";
    case "READY":
      return "READY";
    case "DONE":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    default:
      return projectStatus;
  }
}

function targetProjectStatus(reviewPlanStatus: string): ProjectStatus | null {
  switch (reviewPlanStatus) {
    case "RUNNING":
      return "ACTIVE";
    case "DONE":
      return "COMPLETED";
    default:
      return null;
  }
}

/** Ghi Project.status theo ReviewPlan (DRAFT→ACTIVE khi bật lịch, ACTIVE→COMPLETED khi xong). */
export async function syncProjectStatusFromReviewPlan(
  projectId: string,
  reviewPlanStatus: string,
) {
  const next = targetProjectStatus(reviewPlanStatus);
  if (!next) return;

  await prisma.project.updateMany({
    where: {
      id: projectId,
      ...(next === "ACTIVE"
        ? { status: "DRAFT" }
        : { status: { in: ["DRAFT", "ACTIVE", "PAUSED"] } }),
    },
    data: { status: next },
  });
}
