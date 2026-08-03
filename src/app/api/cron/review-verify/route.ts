import { NextResponse } from "next/server";
import { verifyAllCompletedReviews } from "@/lib/review-verify-batch";

export const maxDuration = 300;

/** Cron ngoài hoặc gọi tay: ?secret=REVIEW_CRON_SECRET */
export async function GET(req: Request) {
  const secret = process.env.REVIEW_CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "REVIEW_CRON_SECRET chưa cấu hình" }, { status: 503 });
  }
  const url = new URL(req.url);
  const provided = url.searchParams.get("secret") || req.headers.get("x-cron-secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = url.searchParams.get("projectId") ?? undefined;
  const result = await verifyAllCompletedReviews({ projectId });
  return NextResponse.json({
    ok: true,
    ...result,
    message: `Đã quét ${result.checked} bài (${result.projects} dự án)`,
  });
}
