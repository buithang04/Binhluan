import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { ProjectForm } from "@/components/ProjectForm";

type Props = { params: Promise<{ id: string }> };

export default async function EditProjectPage({ params }: Props) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    include: { products: true, media: true },
  });
  if (!project) notFound();

  const packages = await prisma.package.findMany({
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, targetContents: true },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Sửa dự án</h1>
        <p className="page-desc">{project.brandName}</p>
      </div>
      <div className="panel p-5 sm:p-6">
        <ProjectForm
          mode="edit"
          projectId={project.id}
          initialPackages={packages}
          initial={{
            brandName: project.brandName,
            website: project.website,
            brandDescription: project.brandDescription,
            targetAudience: project.targetAudience,
            targetMarket: project.targetMarket,
            writingNotes: project.writingNotes,
            googleMapsUrl: project.googleMapsUrl,
            placeKey: project.placeKey,
            resolvedUrl: project.resolvedUrl,
            packageId: project.packageId,
            desiredRating: project.desiredRating?.toString() ?? null,
            currentRating: project.currentRating?.toString() ?? null,
            reviewCount: project.reviewCount?.toString() ?? null,
            ratingScannedAt: project.ratingScannedAt?.toISOString() ?? null,
            reviewsToPost: project.reviewsToPost?.toString() ?? null,
            startAt: project.startAt.toISOString(),
            endAt: project.endAt.toISOString(),
            products: project.products.map((p) => ({
              name: p.name,
              description: p.description,
            })),
            media: project.media.map((m) => ({
              id: m.id,
              filePath: m.filePath,
              caption: m.caption,
            })),
          }}
        />
      </div>
    </div>
  );
}
