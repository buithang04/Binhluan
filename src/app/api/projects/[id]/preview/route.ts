import { NextResponse } from "next/server";
import { z } from "zod";
import { getOwnedProject, getSessionUser } from "@/lib/content-access";
import { buildProjectVariables, resolveSpinTemplate } from "@/lib/spin";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

const previewSchema = z.object({
  templateId: z.string().min(1),
});

export async function POST(req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const project = await getOwnedProject(id, user.id, user.role === "ADMIN");
  if (!project) return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });

  const body = await req.json();
  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const template = await prisma.contentTemplate.findFirst({
    where: { id: parsed.data.templateId, isActive: true },
  });
  if (!template) {
    return NextResponse.json({ error: "Template không tồn tại" }, { status: 404 });
  }

  const variables = buildProjectVariables(project, template.tone);
  const preview = resolveSpinTemplate(template.bodySpin, variables);

  return NextResponse.json({ preview, template: { code: template.code, tone: template.tone } });
}
