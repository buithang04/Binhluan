import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apmServerFetch } from "@/lib/apm-server";
import { resolveAssignmentMedia } from "@/lib/review-media";
import { fetchLedgerVisibilityByProfile, upsertProfilePlaceReview } from "@/lib/profile-place-review";
import { resolveProjectPlaceKey } from "@/lib/place-key";

type Ctx = { params: Promise<{ id: string; assignmentId: string }> };

async function loadEnrichedPlan(projectId: string, planId: string) {
  const refreshed = await prisma.reviewPlan.findUnique({
    where: { id: planId },
    include: {
      assignments: {
        orderBy: { sortOrder: "asc" },
        include: {
          mediaAsset: { select: { id: true, filePath: true, fileName: true } },
        },
      },
    },
  });
  if (!refreshed) return null;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { googleMapsUrl: true, placeKey: true },
  });
  const placeKey = resolveProjectPlaceKey(
    project?.googleMapsUrl || "",
    project?.placeKey,
  );
  const profileIds = refreshed.assignments
    .map((a) => a.apmProfileId)
    .filter((id): id is string => !!id);
  const ledger = await fetchLedgerVisibilityByProfile(placeKey, profileIds);

  const mediaFull = await prisma.mediaAsset.findMany({
    where: { projectId },
    select: { id: true, filePath: true, fileName: true },
  });
  const mediaFullById = new Map(mediaFull.map((m) => [m.id, m]));

  return {
    ...refreshed,
    assignments: refreshed.assignments.map((a) => {
      const lv = a.apmProfileId ? ledger.get(a.apmProfileId) : null;
      return {
        ...a,
        mediaAssets: resolveAssignmentMedia(a, mediaFullById),
        reviewVisibility: lv?.visibility ?? null,
        lastVerifiedAt: lv?.lastVerifiedAt ?? null,
      };
    }),
  };
}

/** Enqueue xóa review đã đăng trên Google Maps (Chrome đúng mail đã post). */
export async function POST(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, assignmentId } = await ctx.params;
  const forceRetry =
    new URL(req.url).searchParams.get("force") === "1" ||
    new URL(req.url).searchParams.get("retry") === "1";
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: {
      id: true,
      googleMapsUrl: true,
      resolvedUrl: true,
      placeKey: true,
      brandName: true,
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const assignment = await prisma.reviewAssignment.findFirst({
    where: { id: assignmentId, plan: { projectId: id } },
    include: { plan: { select: { id: true } } },
  });
  if (!assignment) {
    return NextResponse.json({ error: "Không tìm thấy bài đăng" }, { status: 404 });
  }

  const placeKey = resolveProjectPlaceKey(
    project.googleMapsUrl,
    project.placeKey,
  );
  const ledger = assignment.apmProfileId
    ? await fetchLedgerVisibilityByProfile(placeKey, [assignment.apmProfileId])
    : new Map();
  const visibility = assignment.apmProfileId
    ? ledger.get(assignment.apmProfileId)?.visibility
    : null;

  const markedDeleted =
    (assignment.status === "SKIPPED" &&
      /^Đã xóa trên Maps/i.test(assignment.error || "")) ||
    visibility === "DELETED";

  if (markedDeleted && !forceRetry) {
    const plan = await loadEnrichedPlan(id, assignment.plan.id);
    return NextResponse.json({
      plan,
      message: "Bài này đang đánh dấu đã xóa — bấm Xóa lại nếu vẫn còn trên Maps",
      alreadyDeleted: true,
      canRetry: true,
    });
  }

  if (
    assignment.status !== "COMPLETED" &&
    !(markedDeleted && forceRetry)
  ) {
    return NextResponse.json(
      {
        error: `Chỉ xóa được bài đã đăng (COMPLETED) hoặc Xóa lại bài đã đánh dấu xóa — hiện: ${assignment.status}`,
      },
      { status: 400 },
    );
  }
  if (!assignment.apmProfileId) {
    return NextResponse.json(
      { error: "Bài chưa gắn mail/profile — không thể xóa trên Maps" },
      { status: 400 },
    );
  }

  if (/Đang xóa trên Maps/i.test(assignment.error || "") && !forceRetry) {
    const plan = await loadEnrichedPlan(id, assignment.plan.id);
    return NextResponse.json({
      plan,
      message: "Đang xóa trên Maps — vui lòng chờ",
      queued: true,
    });
  }

  // Retry sau báo xóa giả: mở lại COMPLETED + gỡ ledger DELETED để UI/poll không coi là xong
  if (markedDeleted && forceRetry) {
    try {
      await upsertProfilePlaceReview({
        profileId: assignment.apmProfileId,
        accountEmail: assignment.profileEmail ?? "",
        placeKey,
        placeName: project.brandName,
        googleMapsUrl: project.googleMapsUrl,
        resolvedUrl: project.resolvedUrl,
        stars: assignment.stars,
        reviewText: assignment.reviewText,
        reviewLink: assignment.reviewLink,
        assignmentId: assignment.id,
        projectId: project.id,
        source: "POSTED",
        visibility: "VISIBLE",
      });
    } catch (e) {
      console.warn(
        "[delete-review] reset ledger failed:",
        e instanceof Error ? e.message : e,
      );
    }
    await prisma.reviewAssignment.update({
      where: { id: assignment.id },
      data: {
        status: "COMPLETED",
        error: "Đang xóa trên Maps…",
      },
    });
  }

  try {
    const res = await apmServerFetch<{ jobRunId: string }>(
      `/profiles/${assignment.apmProfileId}/run`,
      {
        method: "POST",
        body: JSON.stringify({
          taskCode: "MAPS_DELETE_REVIEW",
          payload: {
            assignmentId: assignment.id,
            placeUrl: project.resolvedUrl || project.googleMapsUrl,
            reviewLink: assignment.reviewLink || null,
            reviewText: assignment.reviewText || null,
            stars: assignment.stars,
          },
        }),
      },
    );

    await prisma.reviewAssignment.update({
      where: { id: assignment.id },
      data: {
        status: "COMPLETED",
        apmJobRunId: res.jobRunId,
        error: "Đang xóa trên Maps…",
      },
    });

    const plan = await loadEnrichedPlan(id, assignment.plan.id);
    return NextResponse.json({
      plan,
      jobRunId: res.jobRunId,
      message: `Đã enqueue xóa bài #${assignment.sortOrder + 1} — chỉ báo Đã xóa khi Maps xác nhận`,
      queued: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: msg || "Không enqueue được job xóa" },
      { status: 500 },
    );
  }
}
