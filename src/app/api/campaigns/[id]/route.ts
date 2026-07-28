import { NextResponse } from "next/server";
import { z } from "zod";
import { getOwnedCampaign, getSessionUser } from "@/lib/content-access";
import { enhanceWithDeepSeek, generateWithPromptJson } from "@/lib/deepseek";
import { prisma } from "@/lib/prisma";
import { buildProjectVariables, generateVariants } from "@/lib/spin";

type Ctx = { params: Promise<{ id: string }> };

const generateSchema = z.object({
  count: z.number().int().min(1).max(50).optional(),
  useDeepSeek: z.boolean().optional(),
  usePromptJson: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const campaign = await getOwnedCampaign(id, user.id, user.role === "ADMIN");
  if (!campaign) return NextResponse.json({ error: "Không tìm thấy chiến dịch" }, { status: 404 });

  return NextResponse.json({ campaign });
}

export async function POST(req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const campaign = await getOwnedCampaign(id, user.id, user.role === "ADMIN");
  if (!campaign) return NextResponse.json({ error: "Không tìm thấy chiến dịch" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const existingInProject = await prisma.generatedContent.count({
    where: { campaign: { projectId: campaign.projectId } },
  });
  const packageLimit = campaign.project.package.targetContents;
  const remainingPackage = Math.max(0, packageLimit - existingInProject);

  const existingInCampaign = campaign.contents.length;
  const remainingCampaign = Math.max(0, campaign.targetCount - existingInCampaign);
  const count = Math.min(parsed.data.count ?? 10, remainingCampaign, remainingPackage, 50);

  if (count <= 0) {
    return NextResponse.json({ error: "Đã đủ số lượng nội dung cho phép" }, { status: 400 });
  }

  const hasDeepSeekKey = !!process.env.DEEPSEEK_API_KEY;
  const useDeepSeek = parsed.data.useDeepSeek && hasDeepSeekKey;
  const usePromptJson = parsed.data.usePromptJson !== false && useDeepSeek;

  const variables = buildProjectVariables(campaign.project, campaign.template.tone);
  const variants = generateVariants(campaign.template.bodySpin, variables, count);

  const created = [];
  let deepSeekUsed = false;
  let promptJsonUsed = false;

  for (const v of variants) {
    let text = v.resolvedText;
    const rawSpin = v.rawSpin;

    if (usePromptJson) {
      const gen = await generateWithPromptJson(
        campaign.project.contentPromptJson,
        campaign.project,
        v.resolvedText,
      );
      if (gen.text) {
        text = gen.text;
        deepSeekUsed = true;
        promptJsonUsed = true;
      } else if (gen.error) {
        return NextResponse.json({ error: gen.error }, { status: 502 });
      }
    } else if (useDeepSeek) {
      const enhanced = await enhanceWithDeepSeek(text, {
        brandName: campaign.project.brandName,
        writingNotes: campaign.project.writingNotes,
        targetAudience: campaign.project.targetAudience,
        contentDirection: campaign.project.contentDirection,
        contentLanguage: campaign.project.contentLanguage,
        contentExample: campaign.project.contentExample,
        contentWordCount: campaign.project.contentWordCount,
      });
      if (enhanced) {
        text = enhanced;
        deepSeekUsed = true;
      }
    }

    const row = await prisma.generatedContent.create({
      data: {
        campaignId: campaign.id,
        rawSpin,
        resolvedText: text,
        variantIndex: existingInCampaign + v.variantIndex,
        status: "GENERATED",
      },
    });
    created.push(row);
  }

  const totalNow = existingInProject + created.length;
  if (totalNow >= campaign.targetCount || totalNow >= packageLimit) {
    await prisma.contentCampaign.update({
      where: { id: campaign.id },
      data: { status: "COMPLETED" },
    });
  }

  return NextResponse.json({
    created: created.length,
    contents: created,
    deepSeekUsed,
    promptJsonUsed,
  });
}
