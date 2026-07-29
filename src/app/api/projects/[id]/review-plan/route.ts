import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  planReviewStars,
} from "@/lib/review-planner";
import {
  parseReviewSpinByStar,
  resolveReviewTextForStar,
  availableReviewProfileWhere,
  prioritizeProfilesWith2Fa,
} from "@/lib/review-content";
import { pickRandomMediaAssets, enrichPlanAssignments } from "@/lib/review-media";
import { planReviewScheduleDates } from "@/lib/review-schedule";

type Ctx = { params: Promise<{ id: string }> };

async function getProject(id: string, userId: string, isAdmin: boolean) {
  return prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId },
    include: {
      package: true,
      media: { orderBy: { createdAt: "asc" } },
      products: true,
    },
  });
}

export async function GET(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const light = new URL(req.url).searchParams.get("light") === "1";

  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  // Poll nhẹ: chỉ status cần refresh UI — không load/enrich media
  if (light) {
    const plan = await prisma.reviewPlan.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        assignments: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            status: true,
            reviewLink: true,
            error: true,
            scheduledAt: true,
          },
        },
      },
    });
    const mediaCount = await prisma.mediaAsset.count({ where: { projectId: id } });
    return NextResponse.json({ plan: plan ?? null, mediaCount });
  }

  const plan = await prisma.reviewPlan.findFirst({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    include: {
      assignments: {
        orderBy: { sortOrder: "asc" },
        include: { mediaAsset: { select: { id: true, filePath: true, fileName: true } } },
      },
    },
  });

  const media = await prisma.mediaAsset.findMany({
    where: { projectId: id },
    select: { id: true, filePath: true, fileName: true },
    orderBy: { createdAt: "asc" },
  });

  if (!plan) {
    return NextResponse.json({ plan: null, mediaCount: media.length });
  }

  return NextResponse.json({
    plan: {
      ...plan,
      assignments: enrichPlanAssignments(plan.assignments, media),
    },
    mediaCount: media.length,
  });
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await getProject(id, session.user.id, isAdmin);
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const reviewsToPost = project.package.targetContents;
  const reviewCount = project.reviewCount ?? 0;
  const hasCurrent =
    project.currentRating != null || reviewCount <= 0;
  if (project.desiredRating == null || !hasCurrent) {
    return NextResponse.json(
      {
        error:
          "Cần có số sao hiện tại và số sao mong muốn trên dự án (place chưa có review: nhập 0 lượt / để trống sao)",
      },
      { status: 400 },
    );
  }

  if (!project.reviewContentGeneratedAt) {
    return NextResponse.json(
      {
        error:
          "Cần sinh nội dung review theo sao trước khi lập kế hoạch (Nội dung bình luận)",
      },
      { status: 400 },
    );
  }

  const spinByStar = parseReviewSpinByStar(project.reviewSpinByStar);

  const existingPlan = await prisma.reviewPlan.findFirst({
    where: {
      projectId: id,
      status: { in: ["READY", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      assignments: {
        where: { status: "COMPLETED" },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  const completedKeep = existingPlan?.assignments ?? [];
  const remainingSlots = Math.max(0, reviewsToPost - completedKeep.length);
  if (remainingSlots === 0) {
    return NextResponse.json(
      {
        error: `Đã có ${completedKeep.length} bài COMPLETED — đủ gói ${reviewsToPost}, không cần lập lại`,
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const pool = prioritizeProfilesWith2Fa(
    await prisma.profile.findMany({
      where: availableReviewProfileWhere(now),
      include: { account: { select: { email: true, totpSecretEnc: true } } },
    }),
  );
  const usedEmails = new Set(
    completedKeep.map((a) => a.profileEmail).filter(Boolean) as string[],
  );
  const readyProfiles = pool
    .filter((p) => !usedEmails.has(p.account.email))
    .slice(0, remainingSlots);

  if (readyProfiles.length < remainingSlots) {
    return NextResponse.json(
      {
        error: `Cần ${remainingSlots} mail READY còn trống (đã giữ ${completedKeep.length} bài hoàn thành), hiện có ${readyProfiles.length}`,
      },
      { status: 400 },
    );
  }

  const planned = planReviewStars({
    currentRating:
      project.currentRating != null ? Number(project.currentRating) : 0,
    reviewCount: project.reviewCount ?? 0,
    desiredRating: Number(project.desiredRating),
    reviewsToPost,
  });

  // Chỉ lấy slot còn lại (bỏ qua số đã COMPLETED theo thứ tự sort)
  const newSlots = planned.slots.slice(completedKeep.length);

  const neededStars = new Set(newSlots.map((s) => String(s.stars)));
  for (const s of neededStars) {
    if (!spinByStar[s]) {
      return NextResponse.json(
        { error: `Thiếu template spin cho ${s}★ — sinh lại nội dung review` },
        { status: 400 },
      );
    }
  }

  const media = project.media;

  if (project.endAt < project.startAt) {
    return NextResponse.json(
      { error: "Ngày kết thúc phải sau ngày bắt đầu (Gói & thời gian)" },
      { status: 400 },
    );
  }

  const scheduleDates = planReviewScheduleDates(
    project.startAt,
    project.endAt,
    reviewsToPost,
  );

  const newAssignmentsData = newSlots.map((slot, i) => {
    const globalIndex = completedKeep.length + i;
    const reviewText = resolveReviewTextForStar(
      slot.stars,
      spinByStar,
      project,
      project.brandName,
    );
    const pickedMedia = media.length ? pickRandomMediaAssets(media) : [];
    const profile = readyProfiles[i]!;
    return {
      sortOrder: globalIndex,
      stars: slot.stars,
      reviewText,
      mediaAssetId: pickedMedia[0]?.id ?? null,
      mediaAssetIds: pickedMedia.map((m) => m.id),
      scheduledAt:
        scheduleDates[globalIndex] ??
        scheduleDates[scheduleDates.length - 1] ??
        project.startAt,
      apmProfileId: profile.id,
      profileEmail: profile.account.email,
      status: "PENDING" as const,
    };
  });

  if (project.reviewsToPost !== reviewsToPost) {
    await prisma.project.update({
      where: { id },
      data: { reviewsToPost },
    });
  }

  const plan = await prisma.$transaction(async (tx) => {
    await tx.reviewPlan.updateMany({
      where: {
        projectId: id,
        status: { in: ["DRAFT", "READY"] },
        ...(existingPlan ? { id: { not: existingPlan.id } } : {}),
      },
      data: { status: "FAILED" },
    });

    // Cập nhật kế hoạch hiện có: giữ COMPLETED, thay các bài chưa xong
    if (existingPlan) {
      await tx.reviewAssignment.deleteMany({
        where: {
          planId: existingPlan.id,
          status: { not: "COMPLETED" },
        },
      });
      if (newAssignmentsData.length) {
        await tx.reviewAssignment.createMany({
          data: newAssignmentsData.map((a) => ({
            ...a,
            planId: existingPlan.id,
          })),
        });
      }
      return tx.reviewPlan.update({
        where: { id: existingPlan.id },
        data: {
          status: existingPlan.status === "RUNNING" ? "RUNNING" : "READY",
          snapshot: {
            ...planned,
            profileCount: readyProfiles.length + completedKeep.length,
            ratingScannedAt: project.ratingScannedAt,
            completedKept: completedKeep.length,
            remainingPlanned: newAssignmentsData.length,
          },
        },
        include: {
          assignments: {
            orderBy: { sortOrder: "asc" },
            include: {
              mediaAsset: { select: { id: true, filePath: true, fileName: true } },
            },
          },
        },
      });
    }

    const created = await tx.reviewPlan.create({
      data: {
        projectId: id,
        status: "READY",
        snapshot: {
          ...planned,
          profileCount: readyProfiles.length,
          ratingScannedAt: project.ratingScannedAt,
          completedKept: 0,
          remainingPlanned: newAssignmentsData.length,
        },
        assignments: { create: newAssignmentsData },
      },
      include: {
        assignments: {
          orderBy: { sortOrder: "asc" },
          include: {
            mediaAsset: { select: { id: true, filePath: true, fileName: true } },
          },
        },
      },
    });

    return created;
  });

  const enriched = {
    ...plan,
    assignments: enrichPlanAssignments(plan.assignments, media),
  };

  return NextResponse.json({
    plan: enriched,
    planned,
    message:
      completedKeep.length > 0
        ? `Đã giữ ${completedKeep.length} bài hoàn thành, lập lại ${newAssignmentsData.length} bài còn lại`
        : undefined,
  });
}
