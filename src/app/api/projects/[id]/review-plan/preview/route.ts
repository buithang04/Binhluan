import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { planReviewStars } from "@/lib/review-planner";
import {
  parseReviewSpinByStar,
  resolveReviewTextForStar,
} from "@/lib/review-content";
import {
  pickRandomMediaAssets,
  summarizeImageCounts,
} from "@/lib/review-media";
import { planReviewScheduleDates } from "@/lib/review-schedule";

type Ctx = { params: Promise<{ id: string }> };

/** Xem trước phân ảnh + nội dung (không ghi DB). */
export async function GET(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const url = new URL(req.url);
  const limit = Math.min(12, Math.max(3, Number(url.searchParams.get("limit") || 6)));

  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    include: {
      package: true,
      media: { orderBy: { createdAt: "asc" } },
      products: true,
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  if (project.desiredRating == null || project.currentRating == null) {
    return NextResponse.json(
      { error: "Cần có số sao hiện tại và mục tiêu" },
      { status: 400 },
    );
  }

  const reviewsToPost = project.package.targetContents;
  const planned = planReviewStars({
    currentRating: Number(project.currentRating),
    reviewCount: project.reviewCount ?? 0,
    desiredRating: Number(project.desiredRating),
    reviewsToPost,
  });

  const spinByStar = parseReviewSpinByStar(project.reviewSpinByStar);
  const scheduleDates = planReviewScheduleDates(
    project.startAt,
    project.endAt,
    Math.min(limit, planned.slots.length),
  );

  const samples = planned.slots.slice(0, limit).map((slot, i) => {
    const picked = project.media.length ? pickRandomMediaAssets(project.media) : [];
    const mediaAssets = picked.map((m) => ({
      id: m.id,
      filePath: m.filePath,
      fileName: m.fileName,
    }));
    return {
      sortOrder: i,
      stars: slot.stars,
      reviewText: resolveReviewTextForStar(
        slot.stars,
        spinByStar,
        project,
        project.brandName,
      ),
      scheduledAt: scheduleDates[i]?.toISOString() ?? null,
      mediaAssets,
    };
  });

  const imageSummary = summarizeImageCounts(
    samples.map((s) => s.mediaAssets.length),
  );

  return NextResponse.json({
    mediaCount: project.media.length,
    campaignStart: project.startAt,
    campaignEnd: project.endAt,
    samples,
    imageSummary,
    note:
      project.media.length < 2
        ? "Thư viện chỉ có 1 ảnh — mỗi bài chỉ gắn được 1 ảnh. Thêm ảnh vào thư viện để random 2–3 ảnh."
        : "Ảnh và giờ đăng là mẫu ngẫu nhiên. Bấm Lập kế hoạch để cố định lịch đăng.",
  });
}
