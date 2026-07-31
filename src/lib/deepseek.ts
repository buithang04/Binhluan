import {
  buildPromptContext,
  DEFAULT_DEEPSEEK_PROMPT_JSON,
  resolvePromptJson,
} from "@/lib/prompt-template";
import {
  STAR_SPIN_RESPONSE_FORMAT,
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
  const baseUrl =
    opts?.baseUrl || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  if (!apiKey) {
    return { text: null, error: "Thiếu DEEPSEEK_API_KEY trong .env" };
  }

  // Ép json_object khi sinh batch star spins
  let responseFormat = payload.response_format;
  if (opts?.forceSchema !== false) {
    responseFormat = STAR_SPIN_RESPONSE_FORMAT;
  } else {
    const rf = responseFormat as { type?: string } | undefined;
    // Prompt cũ còn json_schema → đổi sang json_object (1 call, không retry)
    if (rf?.type === "json_schema") {
      responseFormat = STAR_SPIN_RESPONSE_FORMAT;
    }
  }

  const buildBody = (rf: unknown | undefined) => {
    const body: Record<string, unknown> = {
      model: payload.model || "deepseek-v4-flash",
      messages: payload.messages,
      max_tokens: payload.max_tokens ?? 100000,
      ...(rf != null ? { response_format: rf } : {}),
    };
   
    if (opts?.forceSchema !== false) {
      body.thinking = { type: "disabled" };
    } else if (payload.temperature != null) {
      body.temperature = payload.temperature;
    }
    return body;
  };

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

    const { res, errBody } = await attempt(responseFormat);

    if (!res.ok) {
      return { text: null, error: shortDeepSeekHttpError(res.status, errBody) };
    }

    const data = (await res.json()) as {
      choices?: {
        finish_reason?: string;
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
        };
      }[];
      usage?: {
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const text = msg?.content?.trim() || "";
    // Một số bản trả JSON trong content; nếu rỗng chỉ có reasoning → coi fail rõ
    if (!text) {
      const reasoningTok =
        data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      if (choice?.finish_reason === "length" || reasoningTok > 0) {
        return {
          text: null,
          error: "DeepSeek hết token (thinking) — thử Sinh lại",
        };
      }
      return { text: null, error: "DeepSeek trả về rỗng" };
    }
    return { text };
  } catch (e) {
    return {
      text: null,
      error: e instanceof Error ? e.message.slice(0, 80) : "Lỗi gọi DeepSeek",
    };
  }
}

function shortDeepSeekHttpError(status: number, errBody: string): string {
  if (/response_format type is unavailable|json_schema/i.test(errBody)) {
    return "DeepSeek không hỗ trợ định dạng JSON này";
  }
  if (status === 401 || status === 403) return "DeepSeek: sai API key";
  if (status === 429) return "DeepSeek: quá giới hạn — thử lại sau";
  if (status >= 500) return "DeepSeek lỗi máy chủ — thử lại";
  try {
    const j = JSON.parse(errBody) as { error?: { message?: string } };
    const msg = j?.error?.message?.trim();
    if (msg) return `DeepSeek: ${msg.slice(0, 80)}`;
  } catch {
    /* ignore */
  }
  return `DeepSeek lỗi HTTP ${status}`;
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

  // Ép model + json_object (DeepSeek không hỗ trợ json_schema)
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
