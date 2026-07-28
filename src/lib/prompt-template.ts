/**
 * DeepSeek prompt template — biểu thức kiểu n8n: {{ $json.project.brand_name }}
 * $json = context gồm project, settings, spin (khi có).
 */

export type PromptContextJson = {
  project: Record<string, string>;
  settings: Record<string, string>;
  spin?: Record<string, string>;
};

const EXPR =
  /\{\{\s*(?:\$json\.)?([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g;

export type PromptJsonParseResult = {
  ok: boolean;
  error?: string;
  line?: number;
  column?: number;
};

/** Kiểm tra JSON prompt (cho UI) — không resolve biến. */
export function validatePromptJsonText(raw: string): PromptJsonParseResult {
  const { error, line, column } = tryParsePromptJson(raw);
  if (error) return { ok: false, error, line, column };
  return { ok: true };
}

function tryParsePromptJson(raw: string): {
  parsed?: unknown;
  error?: string;
  line?: number;
  column?: number;
} {
  const cleaned = stripTrailingCommas(raw.trim());
  try {
    return { parsed: JSON.parse(cleaned) };
  } catch {
    // Thử bọc biểu thức n8n đứng ngoài chuỗi: ": {{ $json.x }}" → ": \"{{ $json.x }}\""
  }

  const fixed = wrapBareExpressions(cleaned);
  try {
    return { parsed: JSON.parse(fixed) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "JSON prompt không hợp lệ";
    const pos = parseJsonErrorPosition(msg);
    if (pos != null) {
      const { line, column } = offsetToLineCol(fixed, pos);
      return {
        error: `${msg} (dòng ${line}, cột ${column})`,
        line,
        column,
      };
    }
    return { error: msg };
  }
}

function stripTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, "$1");
}

/** Bọc {{ ... }} khi đứng làm giá trị JSON (không nằm trong "..." ). */
function wrapBareExpressions(json: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;

  while (i < json.length) {
    const ch = json[i];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (json[i] === "{" && json[i + 1] === "{") {
      const start = i;
      const end = json.indexOf("}}", i);
      if (end === -1) {
        out += ch;
        i++;
        continue;
      }
      const expr = json.slice(start, end + 2);
      const before = out.trimEnd();
      const needsQuotes =
        before.endsWith(":") ||
        before.endsWith("[") ||
        before.endsWith(",");

      if (needsQuotes) {
        out += `"${expr}"`;
      } else {
        out += expr;
      }
      i = end + 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function parseJsonErrorPosition(msg: string): number | null {
  const m = msg.match(/position (\d+)/i);
  return m ? Number(m[1]) : null;
}

function offsetToLineCol(text: string, offset: number) {
  const slice = text.slice(0, offset);
  const lines = slice.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function formatExpression(path: string): string {
  const p = path.startsWith("$json.") ? path : `$json.${path.replace(/^\$json\./, "")}`;
  return `{{ ${p} }}`;
}

/** Caret có đang nằm trong chuỗi JSON "..." hay không. */
export function caretInsideJsonString(text: string, index: number): boolean {
  let inString = false;
  let escape = false;
  for (let i = 0; i < index && i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    }
  }
  return inString;
}

export const DEFAULT_DEEPSEEK_PROMPT_JSON = `{
  "model": "deepseek-chat",
  "temperature": 0.85,
  "max_tokens": 800,
  "messages": [
    {
      "role": "system",
      "content": "Bạn là copywriter chuyên viết bình luận Google Maps bằng {{ $json.settings.content_language }}. Viết tự nhiên, không quảng cáo lộ liễu. Chỉ trả về nội dung review, không giải thích."
    },
    {
      "role": "user",
      "content": "Thương hiệu: {{ $json.project.brand_name }}\\nWebsite: {{ $json.project.website }}\\nMô tả: {{ $json.project.brand_description }}\\nKhách hàng mục tiêu: {{ $json.project.target_audience }}\\nThị trường: {{ $json.project.target_market }}\\nSản phẩm:\\n{{ $json.project.product_list }}\\n\\nĐịnh hướng: {{ $json.settings.content_direction }}\\nSố từ mục tiêu: {{ $json.settings.content_word_count }}\\nVí dụ tham khảo:\\n{{ $json.settings.content_example }}\\n\\nViết 1 bình luận review Google Maps duy nhất."
    }
  ]
}`;

/** Danh sách biến hiển thị trên UI (path n8n). */
export const PROMPT_VARIABLE_GROUPS: {
  label: string;
  items: { path: string; label: string }[];
}[] = [
  {
    label: "project",
    items: [
      { path: "$json.project.brand_name", label: "Tên thương hiệu" },
      { path: "$json.project.website", label: "Website" },
      { path: "$json.project.brand_description", label: "Mô tả brand" },
      { path: "$json.project.target_audience", label: "Target audience" },
      { path: "$json.project.target_market", label: "Target market" },
      { path: "$json.project.writing_notes", label: "Lưu ý viết" },
      { path: "$json.project.product_list", label: "Danh sách SP" },
      { path: "$json.project.first_product", label: "SP đầu tiên" },
      { path: "$json.project.google_maps_url", label: "Link Maps" },
    ],
  },
  {
    label: "settings",
    items: [
      { path: "$json.settings.content_direction", label: "Định hướng nội dung" },
      { path: "$json.settings.content_language", label: "Ngôn ngữ" },
      { path: "$json.settings.content_example", label: "Ví dụ tham khảo" },
      { path: "$json.settings.content_word_count", label: "Số từ" },
    ],
  },
  {
    label: "spin",
    items: [{ path: "$json.spin.resolved_text", label: "Text spin (nếu dùng kèm template)" }],
  },
];

function lookupPath(ctx: PromptContextJson, path: string): string {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur == null) return "";
  return String(cur);
}

/** Thay {{ $json.project.x }} hoặc {{ project.x }} bằng giá trị thật. */
export function resolveExpressionString(
  template: string,
  ctx: PromptContextJson,
): string {
  return template.replace(EXPR, (_, path: string) => lookupPath(ctx, path));
}

function resolveDeep(value: unknown, ctx: PromptContextJson): unknown {
  if (typeof value === "string") return resolveExpressionString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveDeep(v, ctx);
    }
    return out;
  }
  return value;
}

export function resolvePromptJson(
  promptJson: string,
  ctx: PromptContextJson,
): { payload?: Record<string, unknown>; error?: string } {
  const { parsed, error } = tryParsePromptJson(promptJson);
  if (error || parsed == null) {
    return { error: error || "JSON prompt không hợp lệ" };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Prompt phải là object JSON" };
  }
  const resolved = resolveDeep(parsed, ctx) as Record<string, unknown>;
  if (!Array.isArray(resolved.messages)) {
    return { error: "Prompt cần có mảng messages" };
  }
  return { payload: resolved };
}

export function buildPromptContext(
  project: {
    brandName: string;
    website: string | null;
    brandDescription: string;
    targetAudience: string;
    targetMarket: string;
    writingNotes: string | null;
    googleMapsUrl: string;
    contentDirection?: string | null;
    contentLanguage?: string | null;
    contentExample?: string | null;
    contentWordCount?: number | null;
    products: { name: string; description: string }[];
  },
  spinText?: string,
): PromptContextJson {
  const productList = project.products
    .map((p, i) => `${i + 1}. ${p.name}: ${p.description}`)
    .join("\n");

  const ctx: PromptContextJson = {
    project: {
      brand_name: project.brandName,
      website: project.website || "",
      brand_description: project.brandDescription,
      target_audience: project.targetAudience,
      target_market: project.targetMarket,
      writing_notes: project.writingNotes || "",
      product_list: productList,
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
  };

  if (spinText != null) {
    ctx.spin = { resolved_text: spinText };
  }

  return ctx;
}
