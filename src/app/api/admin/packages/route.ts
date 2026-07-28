import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

const packageSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  targetContents: z.number().int().min(1).max(5000),
});

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const packages = await prisma.package.findMany({
    orderBy: { code: "asc" },
    include: { _count: { select: { projects: true } } },
  });
  return NextResponse.json({ packages });
}

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await req.json();
  const parsed = packageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const pkg = await prisma.package.create({
    data: {
      code: parsed.data.code.toUpperCase(),
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      maxProducts: 200, // legacy DB — gói không còn giới hạn SP
      maxMedia: 50,
      targetContents: parsed.data.targetContents,
    },
  });
  return NextResponse.json({ package: pkg }, { status: 201 });
}
