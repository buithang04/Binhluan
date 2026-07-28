import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { getProjectProgressMap } from "@/lib/project-progress";

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const projects = await prisma.project.findMany({
    select: {
      id: true,
      brandName: true,
      status: true,
      startAt: true,
      endAt: true,
      package: { select: { code: true, targetContents: true } },
      user: { select: { email: true, name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const progressMap = await getProjectProgressMap(projects.map((p) => p.id));

  const rows = projects.map((p) => {
    const generated = progressMap.get(p.id) || 0;
    const target = p.package.targetContents;
    const percent = target > 0 ? Math.min(100, Math.round((generated / target) * 100)) : 0;
    return {
      id: p.id,
      brandName: p.brandName,
      userEmail: p.user.email,
      packageCode: p.package.code,
      status: p.status,
      generated,
      target,
      percent,
      startAt: p.startAt,
      endAt: p.endAt,
    };
  });

  return NextResponse.json({ projects: rows });
}
