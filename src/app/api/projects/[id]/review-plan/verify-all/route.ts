import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyAllCompletedReviews } from "@/lib/review-verify-batch";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Quét hàng loạt các bài COMPLETED trong dự án. */
export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const result = await verifyAllCompletedReviews({ projectId: id });
  if (result.checked === 0) {
    return NextResponse.json({
      checked: 0,
      summary: {},
      results: [],
      message: "Không có bài COMPLETED để quét",
    });
  }

  return NextResponse.json({
    checked: result.checked,
    summary: result.summary,
    errors: result.errors,
    message: `Đã quét ${result.checked} bài`,
  });
}
