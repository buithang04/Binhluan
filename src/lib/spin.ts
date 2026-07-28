export type SpinVariables = Record<string, string>;

const SPIN_BLOCK = /\{([^{}]+)\}/g;
const VAR_BLOCK = /\[\$([a-zA-Z_][a-zA-Z0-9_]*)\]/g;

const TONE_OPENERS: Record<string, string[]> = {
  FORMAL: ["Kính gửi anh chị", "Xin chào anh chị", "Thưa anh chị"],
  FRIENDLY: ["Em chào anh chị", "Anh chị ơi", "Chào anh chị"],
  CASUAL: ["Hi anh chị", "Chào shop", "Hello anh chị"],
};

const TONE_CLOSERS: Record<string, string[]> = {
  FORMAL: ["Trân trọng.", "Xin cảm ơn anh chị."],
  FRIENDLY: ["Cảm ơn anh chị ạ!", "Em cảm ơn ạ!"],
  CASUAL: ["Thanks anh chị!", "Cảm ơn nhiều nhé!"],
};

function pickRandom(options: string[]): string {
  return options[Math.floor(Math.random() * options.length)]?.trim() ?? "";
}

export function toneVariables(tone: string): SpinVariables {
  const key = tone in TONE_OPENERS ? tone : "FRIENDLY";
  return {
    tone_opener: pickRandom(TONE_OPENERS[key]),
    tone_closer: pickRandom(TONE_CLOSERS[key]),
    tone: key.toLowerCase(),
  };
}

function resolveSpinBlocks(template: string): string {
  let text = template;
  let prev = "";
  // Lặp để xử lý block lồng nhau: luôn resolve block trong cùng trước
  while (text !== prev) {
    prev = text;
    text = text.replace(SPIN_BLOCK, (_, group: string) => {
      const options = group
        .split("|")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (options.length === 0) return "";
      if (options.length === 1) return options[0]!;
      return pickRandom(options);
    });
  }
  // Dọn { } thừa khi template có { mở đầu không đóng đúng (VD: "{text {a|b} ...")
  return text.replace(/[{}]/g, "");
}

/** Resolve {a|b|c} blocks and [$var] placeholders */
export function resolveSpinTemplate(
  template: string,
  variables: SpinVariables = {},
): string {
  let text = resolveSpinBlocks(template);

  text = text.replace(VAR_BLOCK, (_, key: string) => variables[key] ?? `[$${key}]`);
  return text.trim();
}

/** Generate N unique-ish variants from the same template */
export function generateVariants(
  template: string,
  variables: SpinVariables,
  count: number,
): { rawSpin: string; resolvedText: string; variantIndex: number }[] {
  const results: { rawSpin: string; resolvedText: string; variantIndex: number }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < count * 3 && results.length < count; i++) {
    const resolved = resolveSpinTemplate(template, variables);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    results.push({
      rawSpin: template,
      resolvedText: resolved,
      variantIndex: results.length + 1,
    });
  }

  while (results.length < count) {
    const resolved = resolveSpinTemplate(template, variables);
    results.push({
      rawSpin: template,
      resolvedText: resolved,
      variantIndex: results.length + 1,
    });
  }

  return results;
}

export function buildProjectVariables(
  project: {
    brandName: string;
    website: string | null;
    brandDescription: string;
    targetAudience: string;
    targetMarket: string;
    writingNotes: string | null;
    contentDirection?: string | null;
    contentLanguage?: string | null;
    contentExample?: string | null;
    contentWordCount?: number | null;
    products: { name: string; description: string }[];
    user?: { name: string | null; email: string } | null;
  },
  tone = "FRIENDLY",
): SpinVariables {
  const productList = project.products
    .map((p, i) => `${i + 1}. ${p.name}: ${p.description}`)
    .join("\n");

  return {
    ...toneVariables(tone),
    user_name: project.user?.name || project.user?.email || "bạn",
    brand_name: project.brandName,
    website: project.website || "",
    brand_description: project.brandDescription,
    target_audience: project.targetAudience,
    target_market: project.targetMarket,
    writing_notes: project.writingNotes || "",
    content_direction: project.contentDirection || "",
    content_language: project.contentLanguage === "EN" ? "English" : "Vietnamese",
    content_example: project.contentExample || "",
    content_word_count:
      project.contentWordCount != null ? String(project.contentWordCount) : "",
    product_list: productList,
    first_product: project.products[0]?.name || "",
  };
}
