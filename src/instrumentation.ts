export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReviewDispatchLoop } = await import("@/lib/review-dispatch-loop");
  startReviewDispatchLoop();
}
