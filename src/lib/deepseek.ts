import {
  buildPromptContext,
  DEFAULT_DEEPSEEK_PROMPT_JSON,
  resolvePromptJson,
} from "@/lib/prompt-template";

type DeepSeekPayload = {
  model?: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  max_tokens?: number;
};

export async function callDeepSeekPayload(
  payload: DeepSeekPayload,
): Promise<{ text: string | null; error?: string }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  if (!apiKey) {
    return { text: null, error: "Thiếu DEEPSEEK_API_KEY trong .env" };
  }

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: payload.model || "deepseek-chat",
        messages: payload.messages,
        temperature: payload.temperature ?? 0.85,
        max_tokens: payload.max_tokens ?? 800,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return { text: null, error: `DeepSeek HTTP ${res.status}: ${errBody.slice(0, 200)}` };
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() || null;
    return { text };
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : "DeepSeek request failed" };
  }
}

/** Sinh nội dung từ prompt JSON (biểu thức n8n). */
export async function generateWithPromptJson(
  promptJson: string | null | undefined,
  project: Parameters<typeof buildPromptContext>[0],
  spinText?: string,
): Promise<{ text: string | null; resolvedPayload?: Record<string, unknown>; error?: string }> {
  const raw = promptJson?.trim() || DEFAULT_DEEPSEEK_PROMPT_JSON;
  const ctx = buildPromptContext(project, spinText);
  const { payload, error } = resolvePromptJson(raw, ctx);
  if (error || !payload) return { text: null, error: error || "Không resolve được prompt" };

  const result = await callDeepSeekPayload(payload as DeepSeekPayload);
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

  const result = await callDeepSeekPayload({ messages, temperature: 0.8, max_tokens: 800 });
  return result.text;
}

export type { DeepSeekMessage };
