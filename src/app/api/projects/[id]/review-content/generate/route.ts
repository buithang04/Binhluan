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

  if (project.reviewContentGeneratedAt) {
    return NextResponse.json(
      { error: "Dự án đã sinh nội dung review — mỗi dự án chỉ sinh 1 lần" },
      { status: 400 },
    );
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

  const { spinByStar, errors } = await generateAllStarSpins(project, starLevels);
  if (!Object.keys(spinByStar).length) {
    return NextResponse.json(
      { error: errors.join("; ") || "Sinh nội dung thất bại" },
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
    warnings: errors.length ? errors : undefined,
  });
}
