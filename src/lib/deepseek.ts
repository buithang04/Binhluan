import {
  buildPromptContext,
  DEFAULT_DEEPSEEK_PROMPT_JSON,
  resolvePromptJson,
} from "@/lib/prompt-template";
import {
  STAR_SPIN_RESPONSE_FORMAT,
  STAR_SPIN_RESPONSE_FORMAT_JSON_OBJECT,
} from "@/lib/deepseek-schema";
import { loadDeepSeekSettings } from "@/lib/deepseek-settings";

type DeepSeekPayload = {
  model?: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  max_tokens?: number;
  /** JSON mode / json_schema — lấy từ Prompt DeepSeek (JSON) nếu có */
  response_format?: unknown;
};

export async function callDeepSeekPayload(
  payload: DeepSeekPayload,
  opts?: { baseUrl?: string; apiKey?: string; forceSchema?: boolean },
): Promise<{ text: string | null; error?: string }> {
  const apiKey = opts?.apiKey || process.env.DEEPSEEK_API_KEY;
  let baseUrl =
    opts?.baseUrl || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  if (!apiKey) {
    return { text: null, error: "Thiếu DEEPSEEK_API_KEY trong .env" };
  }

  // Ép schema đầu ra khi sinh batch star spins
  let responseFormat = payload.response_format;
  if (opts?.forceSchema !== false) {
    const rf = responseFormat as { type?: string } | undefined;
    if (!rf || rf.type !== "json_schema") {
      responseFormat = STAR_SPIN_RESPONSE_FORMAT;
    }
  }

  const buildBody = (rf: unknown | undefined) => ({
    model: payload.model || "deepseek-v4-flash",
    messages: payload.messages,
    temperature: payload.temperature ?? 0.85,
    max_tokens: payload.max_tokens ?? 800,
    ...(rf != null ? { response_format: rf } : {}),
  });

  try {
    const attempt = async (rf: unknown | undefined) => {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildBody(rf)),
      });
      const errBody = res.ok ? "" : await res.text().catch(() => "");
      return { res, errBody };
    };

    let { res, errBody } = await attempt(responseFormat);

    // Model không hỗ trợ json_schema → fallback json_object
    if (
      !res.ok &&
      responseFormat &&
      typeof responseFormat === "object" &&
      (responseFormat as { type?: string }).type === "json_schema" &&
      (res.status === 400 ||
        /response_format|json_schema|schema|invalid/i.test(errBody))
    ) {
      console.warn(
        "[deepseek] json_schema không hỗ trợ — fallback response_format=json_object",
      );
      ({ res, errBody } = await attempt(STAR_SPIN_RESPONSE_FORMAT_JSON_OBJECT));
    }

    if (!res.ok) {
      return {
        text: null,
        error: `DeepSeek HTTP ${res.status}: ${errBody.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() || null;
    return { text };
  } catch (e) {
    return {
      text: null,
      error: e instanceof Error ? e.message : "DeepSeek request failed",
    };
  }
}

/** Sinh nội dung từ prompt JSON (biểu thức n8n). */
export async function generateWithPromptJson(
  promptJson: string | null | undefined,
  project: Parameters<typeof buildPromptContext>[0],
  spinTextOrOpts?: string | {
    spinText?: string;
    stars?: number;
    starLevels?: number[];
  },
): Promise<{
  text: string | null;
  resolvedPayload?: Record<string, unknown>;
  error?: string;
}> {
  const settings = await loadDeepSeekSettings();
  const raw = promptJson?.trim() || settings.promptJson || DEFAULT_DEEPSEEK_PROMPT_JSON;
  const ctx = buildPromptContext(project, spinTextOrOpts);
  const { payload, error } = resolvePromptJson(raw, ctx);
  if (error || !payload) {
    return { text: null, error: error || "Không resolve được prompt" };
  }

  // Ép model + schema từ cấu hình hệ thống
  payload.model = settings.model;
  payload.response_format = STAR_SPIN_RESPONSE_FORMAT;

  const result = await callDeepSeekPayload(payload as DeepSeekPayload, {
    baseUrl: settings.baseUrl,
    forceSchema: true,
  });
  return { ...result, resolvedPayload: payload };
}

type DeepSeekMessage = { role: "system" | "user"; content: string };

/** Polish spin text — luồng cũ khi không dùng prompt JSON tuỳ chỉnh. */
export async function enhanceWithDeepSeek(
  baseText: string,
  context: {
    brandName: string;
    writingNotes?: string | null;
    targetAudience: string;
    contentDirection?: string | null;
    contentLanguage?: string | null;
    contentExample?: string | null;
    contentWordCount?: number | null;
  },
): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const isEn = context.contentLanguage === "EN";
  const langLabel = isEn ? "English" : "Vietnamese";
  const wordHint =
    context.contentWordCount != null
      ? `Target length: about ${context.contentWordCount} words.`
      : "";

  const messages: DeepSeekMessage[] = [
    {
      role: "system",
      content: isEn
        ? `You are a professional copywriter. Rewrite outreach content in natural ${langLabel}. Keep the core meaning, do not invent false claims. Return only the final text.`
        : `Bạn là copywriter tiếng Việt. Viết lại nội dung outreach ngắn gọn, tự nhiên, chuyên nghiệp. Giữ ý chính, không thêm cam kết sai sự thật. Chỉ trả về nội dung cuối, không giải thích.`,
    },
    {
      role: "user",
      content: `Brand: ${context.brandName}
Audience: ${context.targetAudience}
Language: ${langLabel}
Content direction: ${context.contentDirection || "n/a"}
Notes: ${context.writingNotes || "n/a"}
Reference example: ${context.contentExample || "n/a"}
${wordHint}

Rewrite the following outreach text:
${baseText}`,
    },
  ];

  const settings = await loadDeepSeekSettings();
  const result = await callDeepSeekPayload(
    {
      model: settings.model,
      messages,
      temperature: 0.8,
      max_tokens: 800,
    },
    { baseUrl: settings.baseUrl, forceSchema: false },
  );
  return result.text;
}

export type { DeepSeekMessage };
