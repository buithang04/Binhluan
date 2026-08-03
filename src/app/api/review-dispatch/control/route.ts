import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  invalidateReviewAutoDispatchCache,
  isReviewAutoDispatchPaused,
  setReviewAutoDispatchPaused,
} from "@/lib/review-dispatch-control";

/** Trạng thái tạm dừng đăng tự động (mọi dự án). */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const paused = await isReviewAutoDispatchPaused();
  return NextResponse.json({ paused });
}

/** Bật/tắt đăng tự động — ADMIN. Không dừng job MAPS đang chạy. */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Chỉ admin" }, { status: 403 });
  }

  let body: { paused?: boolean };
  try {
    body = (await req.json()) as { paused?: boolean };
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  if (typeof body.paused !== "boolean") {
    return NextResponse.json(
      { error: "Cần trường paused: true | false" },
      { status: 400 },
    );
  }

  const result = await setReviewAutoDispatchPaused(body.paused);
  invalidateReviewAutoDispatchCache();

  console.log(
    `[review-dispatch] auto-post ${result.paused ? "PAUSED" : "RESUMED"} by ${session.user.email ?? session.user.id}`,
  );

  return NextResponse.json({
    paused: result.paused,
    message: result.paused
      ? "Đã dừng đăng tự động — vẫn đăng tay từng bài được."
      : "Đã bật lại đăng tự động theo lịch.",
  });
}
