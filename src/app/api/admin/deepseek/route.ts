import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { validatePromptJsonText } from "@/lib/prompt-template";
import {
  defaultDeepSeekSettings,
  loadDeepSeekSettings,
  saveDeepSeekSettings,
} from "@/lib/deepseek-settings";
import { STAR_SPIN_OUTPUT_SCHEMA } from "@/lib/deepseek-schema";

export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const settings = await loadDeepSeekSettings();
  return NextResponse.json({
    settings: {
      ...settings,
      outputSchema: STAR_SPIN_OUTPUT_SCHEMA,
    },
  });
}

const bodySchema = z.object({
  model: z.string().min(1).max(120),
  baseUrl: z.string().url().or(z.string().startsWith("http")),
  promptJson: z.string().min(2),
});

export async function PUT(req: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const check = validatePromptJsonText(parsed.data.promptJson);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.error || "promptJson không hợp lệ" },
      { status: 400 },
    );
  }

  try {
    const settings = await saveDeepSeekSettings(parsed.data);
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Lưu thất bại" },
      { status: 400 },
    );
  }
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const body = await req.json().catch(() => ({}));
  if (body?.action === "reset") {
    const d = defaultDeepSeekSettings();
    const settings = await saveDeepSeekSettings(d);
    return NextResponse.json({ settings });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
