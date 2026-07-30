import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  computeProjectStarPlan,
  generateAllStarSpins,
  neededStarLevels,
  parseReviewSpinByStar,
} from "@/lib/review-content";

type Ctx = { params: Promise<{ id: string }> };

/** Chặn double-click: cùng project không chạy 2 generate song song. */
const generatingIds = new Set<string>();

function isRealGeneratedAt(value: Date | null | undefined): boolean {
  if (!value) return false;
  // Sentinel epoch (bug cũ) không tính là đã sinh
  return value.getTime() > 0;
}

export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    include: { package: true, products: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  if (isRealGeneratedAt(project.reviewContentGeneratedAt)) {
    return NextResponse.json(
      { error: "Dự án đã sinh nội dung review — mỗi dự án chỉ sinh 1 lần" },
      { status: 400 },
    );
  }

  // Dọn sentinel epoch nếu còn sót
  if (project.reviewContentGeneratedAt && project.reviewContentGeneratedAt.getTime() === 0) {
    await prisma.project.update({
      where: { id },
      data: { reviewContentGeneratedAt: null },
    });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return NextResponse.json(
      { error: "Thiếu DEEPSEEK_API_KEY trong .env" },
      { status: 503 },
    );
  }

  const planned = computeProjectStarPlan(project);
  if (!planned) {
    return NextResponse.json(
      { error: "Cần có số sao hiện tại, mục tiêu và số bình luận" },
      { status: 400 },
    );
  }

  const starLevels = neededStarLevels(planned.countsByStar);
  if (!starLevels.length) {
    return NextResponse.json({ error: "Không có mức sao nào cần sinh" }, { status: 400 });
  }

  if (generatingIds.has(id)) {
    return NextResponse.json(
      { error: "Đang sinh nội dung — đợi xong hoặc tải lại trang rồi bấm lại nếu lỗi" },
      { status: 409 },
    );
  }
  generatingIds.add(id);

  try {
    const { spinByStar, errors, apiCalls } = await generateAllStarSpins(
      project,
      starLevels,
    );

    const okLevels = starLevels.every((s) => !!spinByStar[String(s)]);
    if (!okLevels || !Object.keys(spinByStar).length) {
      return NextResponse.json(
        {
          error:
            (errors.length ? errors.join("; ") : "Sinh nội dung thất bại") +
            ` (đã gọi DeepSeek ${apiCalls} lần — bấm Sinh lại để thử, không tự lặp)`,
          apiCalls,
          starLevels,
        },
        { status: 502 },
      );
    }

    const updated = await prisma.project.update({
      where: { id },
      data: {
        reviewSpinByStar: spinByStar,
        reviewContentGeneratedAt: new Date(),
      },
      select: {
        reviewSpinByStar: true,
        reviewContentGeneratedAt: true,
      },
    });

    return NextResponse.json({
      spinByStar: parseReviewSpinByStar(updated.reviewSpinByStar),
      generatedAt: updated.reviewContentGeneratedAt,
      planned,
      starLevels,
      apiCalls,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: `${e instanceof Error ? e.message : "Lỗi không xác định"} — bấm Sinh lại`,
      },
      { status: 502 },
    );
  } finally {
    generatingIds.delete(id);
  }
}
