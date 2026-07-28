import { NextResponse } from "next/server";
import { dispatchDueReviewAssignments } from "@/lib/review-dispatch";

/** Gọi thủ công hoặc từ cron ngoài: ?secret=REVIEW_CRON_SECRET */
export async function POST(req: Request) {
  const secret = process.env.REVIEW_CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "REVIEW_CRON_SECRET is not configured" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const provided = url.searchParams.get("secret") || req.headers.get("x-cron-secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await dispatchDueReviewAssignments();
  return NextResponse.json(result);
}
