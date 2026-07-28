import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { BusinessForm } from "@/components/BusinessForm";

type Props = { params: Promise<{ id: string }> };

export default async function EditBusinessPage({ params }: Props) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const business = await prisma.business.findFirst({
    where: { id, userId: session.user.id },
    include: { products: { orderBy: { createdAt: "asc" } } },
  });
  if (!business) notFound();

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-[var(--muted)]">Doanh nghiệp / Sửa</p>
        <h1 className="page-title">Sửa doanh nghiệp</h1>
        <p className="page-desc">{business.brandName}</p>
      </div>
      <div className="panel p-5 sm:p-6">
        <BusinessForm
          mode="edit"
          initial={{
            id: business.id,
            brandName: business.brandName,
            website: business.website,
            brandDescription: business.brandDescription,
            targetAudience: business.targetAudience,
            targetMarket: business.targetMarket,
            writingNotes: business.writingNotes,
            isActive: business.isActive,
            products: business.products.map((p) => ({
              name: p.name,
              description: p.description,
            })),
          }}
        />
      </div>
    </div>
  );
}
