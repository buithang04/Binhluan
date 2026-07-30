import { prisma } from "@/lib/prisma";
import { DEFAULT_STAR_SPIN_PROMPT_JSON } from "@/lib/prompt-template";
import {
  STAR_SPIN_RESPONSE_FORMAT,
  STAR_SPIN_OUTPUT_SCHEMA,
} from "@/lib/deepseek-schema";

export const DEEPSEEK_SETTING_KEY = "deepseek";

export type DeepSeekAppSettings = {
  model: string;
  baseUrl: string;
  /** Prompt JSON đầy đủ (messages + response_format + …) */
  promptJson: string;
  /** Hiển thị schema (read-only trên UI, luôn ép khi call) */
  outputSchema: typeof STAR_SPIN_OUTPUT_SCHEMA;
};

export function defaultDeepSeekSettings(): DeepSeekAppSettings {
  return {
    model: "deepseek-v4-flash",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    promptJson: DEFAULT_STAR_SPIN_PROMPT_JSON,
    outputSchema: STAR_SPIN_OUTPUT_SCHEMA,
  };
}

export async function loadDeepSeekSettings(): Promise<DeepSeekAppSettings> {
  const defaults = defaultDeepSeekSettings();
  try {
    const row = await prisma.systemSetting.findUnique({
      where: { key: DEEPSEEK_SETTING_KEY },
    });
    if (!row?.value) return defaults;
    const parsed = JSON.parse(row.value) as Partial<DeepSeekAppSettings>;
    return {
      model: parsed.model?.trim() || defaults.model,
      baseUrl: parsed.baseUrl?.trim() || defaults.baseUrl,
      promptJson: parsed.promptJson?.trim() || defaults.promptJson,
      outputSchema: STAR_SPIN_OUTPUT_SCHEMA,
    };
  } catch {
    return defaults;
  }
}

export async function saveDeepSeekSettings(
  input: Pick<DeepSeekAppSettings, "model" | "baseUrl" | "promptJson">,
): Promise<DeepSeekAppSettings> {
  const next: DeepSeekAppSettings = {
    model: input.model.trim() || "deepseek-v4-flash",
    baseUrl: input.baseUrl.trim() || "https://api.deepseek.com",
    promptJson: input.promptJson.trim() || DEFAULT_STAR_SPIN_PROMPT_JSON,
    outputSchema: STAR_SPIN_OUTPUT_SCHEMA,
  };

  // Ép response_format schema vào prompt JSON đã lưu
  let promptObj: Record<string, unknown>;
  try {
    promptObj = JSON.parse(next.promptJson) as Record<string, unknown>;
  } catch {
    throw new Error("promptJson không phải JSON hợp lệ");
  }
  promptObj.model = next.model;
  promptObj.response_format = STAR_SPIN_RESPONSE_FORMAT;
  next.promptJson = JSON.stringify(promptObj, null, 2);

  await prisma.systemSetting.upsert({
    where: { key: DEEPSEEK_SETTING_KEY },
    create: {
      key: DEEPSEEK_SETTING_KEY,
      value: JSON.stringify({
        model: next.model,
        baseUrl: next.baseUrl,
        promptJson: next.promptJson,
      }),
    },
    update: {
      value: JSON.stringify({
        model: next.model,
        baseUrl: next.baseUrl,
        promptJson: next.promptJson,
      }),
    },
  });

  return next;
}

/** Prompt hiệu lực: project override → system setting → default. */
export async function resolveEffectivePromptJson(
  projectPromptJson?: string | null,
): Promise<{ promptJson: string; model: string; baseUrl: string }> {
  const settings = await loadDeepSeekSettings();
  const raw = projectPromptJson?.trim() || settings.promptJson;
  let promptObj: Record<string, unknown>;
  try {
    promptObj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    promptObj = JSON.parse(DEFAULT_STAR_SPIN_PROMPT_JSON) as Record<
      string,
      unknown
    >;
  }
  // Luôn ép model + schema từ cấu hình hệ thống
  promptObj.model = settings.model;
  promptObj.response_format = STAR_SPIN_RESPONSE_FORMAT;
  return {
    promptJson: JSON.stringify(promptObj),
    model: settings.model,
    baseUrl: settings.baseUrl,
  };
}
