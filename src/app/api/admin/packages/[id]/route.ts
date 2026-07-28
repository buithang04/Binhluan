import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  code: z.string().trim().min(1).max(32).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  targetContents: z.number().int().min(1).max(5000).optional(),
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
  const pkg = await prisma.package.update({
    where: { id },
    data: {
      ...(data.code ? { code: data.code.toUpperCase() } : {}),
      ...(data.name ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      maxMedia: 50,
      ...(data.targetContents !== undefined ? { targetContents: data.targetContents } : {}),
    },
  });
  return NextResponse.json({ package: pkg });
}
