import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateWithPromptJson } from "@/lib/deepseek";
import {
  DEFAULT_DEEPSEEK_PROMPT_JSON,
  resolvePromptJson,
} from "@/lib/prompt-template";
import { buildProjectVariables, resolveSpinTemplate } from "@/lib/spin";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  promptJson: z.string().optional(),
  templateId: z.string().optional(),
  callDeepSeek: z.boolean().optional(),
});

export async function POST(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    include: { products: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const promptJson =
    body.data.promptJson?.trim() ||
    project.contentPromptJson?.trim() ||
    DEFAULT_DEEPSEEK_PROMPT_JSON;

  let spinText: string | undefined;
  if (body.data.templateId) {
    const template = await prisma.contentTemplate.findFirst({
      where: { id: body.data.templateId, isActive: true },
    });
    if (template) {
      const vars = buildProjectVariables(project, template.tone);
      spinText = resolveSpinTemplate(template.bodySpin, vars);
    }
  }

  const ctxJson = {
    project: {
      brand_name: project.brandName,
      website: project.website || "",
      brand_description: project.brandDescription,
      target_audience: project.targetAudience,
      target_market: project.targetMarket,
      writing_notes: project.writingNotes || "",
      product_list: project.products
        .map((p, i) => `${i + 1}. ${p.name}: ${p.description}`)
        .join("\n"),
      first_product: project.products[0]?.name || "",
      google_maps_url: project.googleMapsUrl,
    },
    settings: {
      content_direction: project.contentDirection || "",
      content_language: project.contentLanguage === "EN" ? "English" : "Vietnamese",
      content_example: project.contentExample || "",
      content_word_count:
        project.contentWordCount != null ? String(project.contentWordCount) : "",
    },
    ...(spinText ? { spin: { resolved_text: spinText } } : {}),
  };

  const { payload, error } = resolvePromptJson(promptJson, ctxJson);
  if (error || !payload) {
    return NextResponse.json({ error: error || "Resolve prompt thất bại" }, { status: 400 });
  }

  if (!body.data.callDeepSeek) {
    return NextResponse.json({
      resolvedPayload: payload,
      spinText,
    });
  }

  const gen = await generateWithPromptJson(promptJson, project, spinText);
  if (gen.error) {
    return NextResponse.json({ error: gen.error, resolvedPayload: payload }, { status: 502 });
  }

  return NextResponse.json({
    resolvedPayload: payload,
    spinText,
    preview: gen.text,
  });
}
