import { ProjectForm } from "@/components/ProjectForm";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export default async function NewProjectPage() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const [packages, activeBusiness] = await Promise.all([
    prisma.package.findMany({
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, targetContents: true },
    }),
    prisma.business.findFirst({
      where: { userId: session.user.id, isActive: true },
      include: { products: { orderBy: { createdAt: "asc" } } },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Tạo dự án</h1>
        <p className="page-desc">
          2 bước: gói & thời gian → thông tin doanh nghiệp
          {activeBusiness
            ? ` · đang dùng hồ sơ Active “${activeBusiness.brandName}”.`
            : " · chưa có doanh nghiệp Active (có thể tạo ở menu Doanh nghiệp)."}
        </p>
      </div>
      <div className="panel p-5 sm:p-6">
        <ProjectForm
          mode="create"
          initialPackages={packages}
          activeBusiness={
            activeBusiness
              ? {
                  brandName: activeBusiness.brandName,
                  website: activeBusiness.website,
                  brandDescription: activeBusiness.brandDescription,
                  targetAudience: activeBusiness.targetAudience,
                  targetMarket: activeBusiness.targetMarket,
                  writingNotes: activeBusiness.writingNotes,
                  products: activeBusiness.products.map((p) => ({
                    name: p.name,
                    description: p.description,
                  })),
                }
              : null
          }
        />
      </div>
    </div>
  );
}
