import { NextResponse } from "next/server";
import { z } from "zod";
import { getOwnedProject, getSessionUser } from "@/lib/content-access";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

const createCampaignSchema = z.object({
  templateId: z.string().min(1),
  targetCount: z.number().int().min(1).max(500).optional(),
});

export async function GET(_req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const isAdmin = user.role === "ADMIN";
  const project = await getOwnedProject(id, user.id, isAdmin);
  if (!project) return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });

  const campaigns = await prisma.contentCampaign.findMany({
    where: { projectId: id },
    include: {
      template: true,
      _count: { select: { contents: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const totalGenerated = campaigns.reduce((sum, c) => sum + c._count.contents, 0);
  const target = project.package.targetContents;
  const progress = target > 0 ? Math.min(100, Math.round((totalGenerated / target) * 100)) : 0;

  return NextResponse.json({
    campaigns,
    progress: { generated: totalGenerated, target, percent: progress },
  });
}

export async function POST(req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const isAdmin = user.role === "ADMIN";
  const project = await getOwnedProject(id, user.id, isAdmin);
  if (!project) return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });

  const body = await req.json();
  const parsed = createCampaignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const template = await prisma.contentTemplate.findFirst({
    where: { id: parsed.data.templateId, isActive: true },
  });
  if (!template) {
    return NextResponse.json({ error: "Template không tồn tại" }, { status: 400 });
  }

  const existingCount = await prisma.generatedContent.count({
    where: { campaign: { projectId: id } },
  });
  const remaining = Math.max(0, project.package.targetContents - existingCount);
  if (remaining === 0) {
    return NextResponse.json(
      { error: `Đã đạt giới hạn ${project.package.targetContents} nội dung của gói` },
      { status: 400 },
    );
  }

  const targetCount = Math.min(
    parsed.data.targetCount ?? 10,
    remaining,
    100,
  );

  const campaign = await prisma.contentCampaign.create({
    data: {
      projectId: id,
      templateId: template.id,
      targetCount,
      status: "ACTIVE",
    },
    include: { template: true, _count: { select: { contents: true } } },
  });

  return NextResponse.json({ campaign }, { status: 201 });
}
