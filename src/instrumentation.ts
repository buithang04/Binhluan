export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Auto-loops chạy cùng web server — bật PM2/start.bat là có dispatch + quét đêm.
  const { startReviewDispatchLoop } = await import("@/lib/review-dispatch-loop");
  startReviewDispatchLoop();
  const { startReviewVerifyLoop } = await import("@/lib/review-verify-loop");
  startReviewVerifyLoop();
}
