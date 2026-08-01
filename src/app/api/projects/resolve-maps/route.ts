import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/content-access";
import { resolveGoogleMapsUrl, resolveGoogleMapsUrlFast } from "@/lib/google-maps";

export const maxDuration = 60;

const schema = z.object({
  url: z.string().trim().min(1),
  /** false = chỉ validate URL (&lt;1s). true = Puppeteer quét sao/lượt. */
  scrape: z.boolean().optional().default(false),
});

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Thiếu link" }, { status: 400 });
  }

  try {
    const result = parsed.data.scrape
      ? await resolveGoogleMapsUrl(parsed.data.url, { scrape: true })
      : await resolveGoogleMapsUrlFast(parsed.data.url);

    if (!result.valid) {
      return NextResponse.json(
        {
          valid: false,
          message: result.validMessage,
          resolvedUrl: result.resolvedUrl,
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      valid: true,
      message: result.validMessage,
      resolvedUrl: result.resolvedUrl,
      placeKey: result.placeKey ?? result.info?.placeKey ?? null,
      placeName: result.info?.placeName ?? null,
      currentRating: result.info?.currentRating ?? null,
      reviewCount: result.info?.reviewCount ?? null,
      source: result.info?.source ?? null,
      scraped: Boolean(parsed.data.scrape),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const chromeMissing = /Could not find Chrome|Chrome.*not found/i.test(msg);
    return NextResponse.json(
      {
        error: chromeMissing
          ? "Không tìm thấy Chrome để quét Maps. Cài Google Chrome hoặc đặt PUPPETEER_EXECUTABLE_PATH."
          : `Không quét được trang Maps: ${msg.slice(0, 200)}`,
      },
      { status: 500 },
    );
  }
}
