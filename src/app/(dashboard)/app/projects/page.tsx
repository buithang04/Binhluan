import Link from "next/link";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getProjectProgressMap } from "@/lib/project-progress";

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
      package: { select: { code: true, targetContents: true } },
      user: { select: { email: true, name: true } },
      _count: { select: { products: true, media: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const progressMap = await getProjectProgressMap(projects.map((p) => p.id));

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

      {projects.length === 0 ? (
        <div className="panel-muted border-dashed px-6 py-14 text-center">
          <p className="font-display text-lg font-semibold text-[var(--ink)]">Chưa có dự án</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Tạo dự án đầu tiên để bắt đầu pipeline.</p>
          <Link href="/app/projects/new" className="btn btn-primary mt-5">
            Tạo dự án
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {projects.map((p) => {
            const generated = progressMap.get(p.id) || 0;
            const target = p.package.targetContents;
            const percent =
              target > 0 ? Math.min(100, Math.round((generated / target) * 100)) : 0;

            return (
              <li key={p.id}>
                <Link
                  href={`/app/projects/${p.id}`}
                  className="panel block px-4 py-4 transition hover:border-[var(--accent)] hover:shadow-[var(--shadow-md)]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-display text-[1.05rem] font-semibold tracking-tight text-[var(--ink)]">
                        {p.brandName}
                      </p>
                      <p className="mt-0.5 text-sm text-[var(--muted)]">
                        Gói {p.package.code} · {p._count.products} SP · {p._count.media} ảnh
                        {isAdmin && p.user?.email ? ` · ${p.user.email}` : ""}
                      </p>
                      <div className="mt-3 flex items-center gap-2 text-xs text-[var(--ink-soft)]">
                        <div className="progress-track w-28">
                          <div className="progress-fill" style={{ width: `${percent}%` }} />
                        </div>
                        <span className="font-mono">
                          {generated}/{target} ({percent}%)
                        </span>
                      </div>
                    </div>
                    <span className="badge badge-neutral">{p.status}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
