import Link from "next/link";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { BusinessInfoPanel } from "@/components/BusinessInfoPanel";
import { ContentPanel } from "@/components/ContentPanel";
import { ProjectMediaPanel } from "@/components/ProjectMediaPanel";
import { ProjectSetupHint } from "@/components/ProjectSetupHint";
import { ReviewPlanPanel } from "@/components/ReviewPlanPanel";
import {
  computeProjectStarPlan,
  getStarPlanBlockers,
  parseReviewSpinByStar,
} from "@/lib/review-content";
import { normalizeStarPlan, toClientReviewPlan } from "@/lib/review-plan-client";

type Props = { params: Promise<{ id: string }> };

export default async function ProjectDetailPage({ params }: Props) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const isAdmin = session.user.role === "ADMIN";

  // Chỉ query cần cho first paint — infra/profile counts để client load nền
  const [project, reviewPlan] = await Promise.all([
    prisma.project.findFirst({
      where: isAdmin ? { id } : { id, userId: session.user.id },
      include: {
        package: true,
        products: true,
        media: {
          select: { id: true, filePath: true, fileName: true, caption: true },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
    prisma.reviewPlan.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      include: {
        assignments: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            sortOrder: true,
            stars: true,
            status: true,
            reviewText: true,
            profileEmail: true,
            reviewLink: true,
            error: true,
            scheduledAt: true,
            mediaAssetIds: true,
            mediaAssetId: true,
            mediaAsset: { select: { id: true, filePath: true, fileName: true } },
          },
        },
      },
    }),
  ]);
  if (!project) notFound();

  const mediaThumbs = project.media.map((m) => ({
    id: m.id,
    filePath: m.filePath,
    fileName: m.fileName,
  }));
  const initialPlan = toClientReviewPlan(reviewPlan, mediaThumbs);
  const initialStarPlan =
    normalizeStarPlan(reviewPlan?.snapshot) ?? computeProjectStarPlan(project);
  const initialBlockers = getStarPlanBlockers(project);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">{project.brandName}</h1>
          <p className="page-desc flex flex-wrap items-center gap-2">
            <span className="badge badge-neutral">{project.status}</span>
            <span>Gói {project.package.code}</span>
          </p>
        </div>
        <Link href={`/app/projects/${project.id}/edit`} className="btn btn-primary">
          Chỉnh sửa
        </Link>
      </div>

      <Suspense fallback={null}>
        <ProjectSetupHint />
      </Suspense>

      <BusinessInfoPanel
        website={project.website}
        googleMapsUrl={project.googleMapsUrl}
        desiredRating={project.desiredRating?.toString() ?? null}
        currentRating={project.currentRating?.toString() ?? null}
        reviewCount={project.reviewCount?.toString() ?? null}
        ratingScannedAt={project.ratingScannedAt?.toISOString() ?? null}
        reviewsToPost={project.package.targetContents.toString()}
        startAt={project.startAt.toISOString().slice(0, 10)}
        endAt={project.endAt.toISOString().slice(0, 10)}
        packageLabel={`${project.package.code} — ${project.package.name}`}
        brandDescription={project.brandDescription}
        targetAudience={project.targetAudience}
        targetMarket={project.targetMarket}
        writingNotes={project.writingNotes}
        products={project.products.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
        }))}
      />

      <div id="project-content" className="scroll-mt-6">
        <ContentPanel
          projectId={project.id}
          initialSettings={{
            contentDirection: project.contentDirection,
            contentLanguage: project.contentLanguage,
            contentExample: project.contentExample,
            contentWordCount: project.contentWordCount,
            contentPromptJson: project.contentPromptJson,
          }}
          initialStarPlan={initialStarPlan}
          initialStarPlanBlockers={initialBlockers}
          initialPackageLimit={project.package.targetContents}
          initialSpinByStar={parseReviewSpinByStar(project.reviewSpinByStar)}
          initialGeneratedAt={
            project.reviewContentGeneratedAt &&
            project.reviewContentGeneratedAt.getTime() > 0
              ? project.reviewContentGeneratedAt.toISOString()
              : null
          }
        />
      </div>

      <div id="project-media" className="scroll-mt-6">
        <ProjectMediaPanel
          projectId={project.id}
          initialMedia={project.media.map((m) => ({
            id: m.id,
            filePath: m.filePath,
            caption: m.caption,
            fileName: m.fileName,
          }))}
        />
      </div>

      <ReviewPlanPanel
        projectId={project.id}
        packageTargetContents={project.package.targetContents}
        initialMediaCount={project.media.length}
        initialContentGenerated={
          !!(
            project.reviewContentGeneratedAt &&
            project.reviewContentGeneratedAt.getTime() > 0
          )
        }
        initialPlan={initialPlan}
        initialStarPreview={initialStarPlan}
        initialBlockers={initialBlockers}
        initialReadyProfileCount={null}
        initialInfraWarnings={[]}
        initialAvailableProxyCount={null}
        initialRatingScannedAt={project.ratingScannedAt?.toISOString() ?? null}
      />
    </div>
  );
}
