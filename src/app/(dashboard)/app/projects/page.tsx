import Link from "next/link";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getProjectProgressMap } from "@/lib/project-progress";
import { isReviewContentGenerated } from "@/lib/review-content";
import { ProjectListClient } from "@/components/ProjectListClient";

export default async function ProjectsPage() {
  const session = await getSession();
  const isAdmin = session?.user?.role === "ADMIN";

  const projects = await prisma.project.findMany({
    where: isAdmin ? undefined : { userId: session!.user.id },
    select: {
      id: true,
      brandName: true,
      status: true,
      updatedAt: true,
      reviewContentGeneratedAt: true,
      package: { select: { code: true, targetContents: true } },
      user: { select: { email: true, name: true } },
      _count: { select: { products: true, media: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const progressMap = await getProjectProgressMap(projects.map((p) => p.id));

  const items = projects.map((p) => {
    const generated = progressMap.get(p.id) || 0;
    const target = p.package.targetContents;
    const percent =
      target > 0 ? Math.min(100, Math.round((generated / target) * 100)) : 0;
    return {
      id: p.id,
      brandName: p.brandName,
      status: p.status,
      packageCode: p.package.code,
      productCount: p._count.products,
      mediaCount: p._count.media,
      userEmail: p.user?.email ?? null,
      generated,
      target,
      percent,
      contentGenerated: isReviewContentGenerated(p.reviewContentGeneratedAt),
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Dự án</h1>
          <p className="page-desc">
            Quản lý doanh nghiệp, sản phẩm, gói và nội dung outreach.
          </p>
        </div>
        <Link href="/app/projects/new" className="btn btn-primary">
          + Tạo dự án
        </Link>
      </div>

      <ProjectListClient initialProjects={items} isAdmin={isAdmin} />
    </div>
  );
}
