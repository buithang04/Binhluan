import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  normalizeStarKey,
  parseReviewSpinByStar,
  validateSpinTemplate,
} from "@/lib/review-content";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  stars: z.union([z.string(), z.number()]),
  template: z.string().min(1, "Template không được rỗng").max(20000),
});

export async function GET(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: {
      reviewSpinByStar: true,
      reviewContentGeneratedAt: true,
      contentDirection: true,
      contentLanguage: true,
      contentExample: true,
      contentWordCount: true,
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  return NextResponse.json({
    spinByStar: parseReviewSpinByStar(project.reviewSpinByStar),
    generatedAt: project.reviewContentGeneratedAt,
    settings: {
      contentDirection: project.contentDirection,
      contentLanguage: project.contentLanguage,
      contentExample: project.contentExample,
      contentWordCount: project.contentWordCount,
    },
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true, reviewSpinByStar: true, reviewContentGeneratedAt: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }
  if (!project.reviewContentGeneratedAt) {
    return NextResponse.json(
      { error: "Cần sinh nội dung trước khi chỉnh sửa template" },
      { status: 400 },
    );
  }

  const body = await req.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Dữ liệu không hợp lệ" },
      { status: 400 },
    );
  }

  const starKey = normalizeStarKey(parsed.data.stars);
  if (!starKey) {
    return NextResponse.json({ error: "Mức sao không hợp lệ (1–5)" }, { status: 400 });
  }

  const template = parsed.data.template.trim();
  const check = validateSpinTemplate(template);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  const current = parseReviewSpinByStar(project.reviewSpinByStar);
  if (!current[starKey]) {
    return NextResponse.json(
      { error: `Chưa có template cho ${starKey}★` },
      { status: 400 },
    );
  }

  const spinByStar = { ...current, [starKey]: template };
  const updated = await prisma.project.update({
    where: { id },
    data: { reviewSpinByStar: spinByStar },
    select: { reviewSpinByStar: true },
  });

  return NextResponse.json({
    stars: starKey,
    template,
    spinByStar: parseReviewSpinByStar(updated.reviewSpinByStar),
  });
}
