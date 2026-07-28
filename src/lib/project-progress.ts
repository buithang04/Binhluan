import { prisma } from "@/lib/prisma";

/** Tiến độ gói = số bình luận Maps COMPLETED (aggregate, không load hết assignment). */
export async function getProjectProgressMap(projectIds: string[]) {
  if (!projectIds.length) return new Map<string, number>();

  const groups = await prisma.reviewAssignment.groupBy({
    by: ["planId"],
    where: {
      status: "COMPLETED",
      plan: { projectId: { in: projectIds } },
    },
    _count: { _all: true },
  });
  if (!groups.length) return new Map();

  const plans = await prisma.reviewPlan.findMany({
    where: { id: { in: groups.map((g) => g.planId) } },
    select: { id: true, projectId: true },
  });
  const planProject = new Map(plans.map((p) => [p.id, p.projectId]));
  const map = new Map<string, number>();
  for (const g of groups) {
    const projectId = planProject.get(g.planId);
    if (!projectId) continue;
    map.set(projectId, (map.get(projectId) || 0) + g._count._all);
  }
  return map;
}
