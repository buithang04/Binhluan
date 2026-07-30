import type { Frame, Page } from "puppeteer";

type EvalTarget = Pick<Page, "evaluate"> | Pick<Frame, "evaluate">;

/**
 * Chạy code trong browser mà KHÔNG bị tsx/esbuild inject `__name`.
 * `new Function(...).toString()` → `function anonymous(...){...}` — CDP chấp nhận.
 */
export async function evalSafe<T>(
  ctx: EvalTarget,
  body: string,
  ...args: unknown[]
): Promise<T> {
  const names = args.map((_, i) => `a${i}`);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...names, body);
  return (await ctx.evaluate(fn as never, ...args)) as T;
}
