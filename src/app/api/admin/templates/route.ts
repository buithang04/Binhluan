import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

const templateSchema = z.object({
  code: z.string().trim().min(2).max(32).regex(/^[A-Z0-9_]+$/i),
  name: z.string().trim().min(2).max(120),
  type: z.enum(["OUTREACH_EMAIL", "CONSULT_MESSAGE", "BRAND_COPY"]),
  tone: z.enum(["FORMAL", "FRIENDLY", "CASUAL"]).optional(),
  bodySpin: z.string().trim().min(20).max(20000),
  isActive: z.boolean().optional(),
});

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const templates = await prisma.contentTemplate.findMany({
    orderBy: { code: "asc" },
    include: { _count: { select: { campaigns: true } } },
  });
  return NextResponse.json({ templates });
}

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await req.json();
  const parsed = templateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ", details: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;
  const template = await prisma.contentTemplate.create({
    data: {
      code: data.code.toUpperCase(),
      name: data.name,
      type: data.type,
      tone: data.tone ?? "FRIENDLY",
      bodySpin: data.bodySpin,
      isActive: data.isActive ?? true,
    },
  });
  return NextResponse.json({ template }, { status: 201 });
}
