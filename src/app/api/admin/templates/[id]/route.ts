import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  code: z.string().trim().min(2).max(32).regex(/^[A-Z0-9_]+$/i).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  type: z.enum(["OUTREACH_EMAIL", "CONSULT_MESSAGE", "BRAND_COPY"]).optional(),
  tone: z.enum(["FORMAL", "FRIENDLY", "CASUAL"]).optional(),
  bodySpin: z.string().trim().min(20).max(20000).optional(),
  isActive: z.boolean().optional(),
});

export async function PUT(req: Request, ctx: Ctx) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const data = parsed.data;
  const template = await prisma.contentTemplate.update({
    where: { id },
    data: {
      ...(data.code ? { code: data.code.toUpperCase() } : {}),
      ...(data.name ? { name: data.name } : {}),
      ...(data.type ? { type: data.type } : {}),
      ...(data.tone ? { tone: data.tone } : {}),
      ...(data.bodySpin ? { bodySpin: data.bodySpin } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
  return NextResponse.json({ template });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  await prisma.contentTemplate.update({
    where: { id },
    data: { isActive: false },
  });
  return NextResponse.json({ ok: true });
}
