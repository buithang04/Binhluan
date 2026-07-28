import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatZodFlatten, optionalContentWordCountSchema } from "@/lib/validations";
import { validatePromptJsonText } from "@/lib/prompt-template";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  contentDirection: z.preprocess((v) => {
    if (v == null) return null;
    const t = String(v).trim();
    return t ? t : null;
  }, z.union([z.null(), z.string().max(2000)])),
  contentLanguage: z.preprocess(
    (v) => {
      const t = String(v ?? "VI").trim().toUpperCase();
      return t === "EN" ? "EN" : "VI";
    },
    z.enum(["VI", "EN"]),
  ),
  contentExample: z.preprocess((v) => {
    if (v == null) return null;
    const t = String(v).trim();
    return t ? t : null;
  }, z.union([z.null(), z.string().max(10000)])),
  contentWordCount: optionalContentWordCountSchema,
  contentPromptJson: z.preprocess((v) => {
    if (v == null) return null;
    const t = String(v).trim();
    return t ? t : null;
  }, z.union([z.null(), z.string().max(50000)])),
});

const selectFields = {
  contentDirection: true,
  contentLanguage: true,
  contentExample: true,
  contentWordCount: true,
  contentPromptJson: true,
} as const;

export async function GET(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: selectFields,
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }
  return NextResponse.json({ settings: project });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const existing = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: formatZodFlatten(parsed.error.flatten()) },
      { status: 400 },
    );
  }

  if (parsed.data.contentPromptJson) {
    const check = validatePromptJsonText(parsed.data.contentPromptJson);
    if (!check.ok) {
      return NextResponse.json(
        { error: check.error || "contentPromptJson không phải JSON hợp lệ" },
        { status: 400 },
      );
    }
  }

  const settings = await prisma.project.update({
    where: { id },
    data: {
      contentDirection: parsed.data.contentDirection,
      contentLanguage: parsed.data.contentLanguage,
      contentExample: parsed.data.contentExample,
      contentWordCount: parsed.data.contentWordCount,
      ...(parsed.data.contentPromptJson !== undefined
        ? { contentPromptJson: parsed.data.contentPromptJson }
        : {}),
    },
    select: selectFields,
  });

  return NextResponse.json({ settings });
}
