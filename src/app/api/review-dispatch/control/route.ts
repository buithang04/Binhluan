import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  invalidateReviewAutoDispatchCache,
  isProjectAutoDispatchPaused,
  setProjectAutoDispatchPaused,
} from "@/lib/review-dispatch-control";

/** Trạng thái tạm dừng đăng tự động theo dự án. */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = new URL(req.url).searchParams.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "Cần projectId" }, { status: 400 });
  }

  const paused = await isProjectAutoDispatchPaused(projectId);
  return NextResponse.json({ paused, projectId });
}

/** Bật/tắt đăng tự động cho 1 dự án — ADMIN. Không dừng job MAPS đang chạy. */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Chỉ admin" }, { status: 403 });
  }

  let body: { paused?: boolean; projectId?: string };
  try {
    body = (await req.json()) as { paused?: boolean; projectId?: string };
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const projectId = body.projectId?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "Cần projectId" }, { status: 400 });
  }
  if (typeof body.paused !== "boolean") {
    return NextResponse.json(
      { error: "Cần trường paused: true | false" },
      { status: 400 },
    );
  }

  const result = await setProjectAutoDispatchPaused(projectId, body.paused);
  invalidateReviewAutoDispatchCache();

  console.log(
    `[review-dispatch] project ${projectId} auto-post ${result.paused ? "PAUSED" : "RESUMED"} by ${session.user.email ?? session.user.id}`,
  );

  return NextResponse.json({
    paused: result.paused,
    projectId,
    message: result.paused
      ? "Đã dừng đăng tự động cho dự án này — vẫn đăng tay từng bài được."
      : "Đã bật lại đăng tự động theo lịch cho dự án này.",
  });
}
