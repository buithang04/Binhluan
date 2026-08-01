import "server-only";

/**
 * Bài / lịch đang chờ proxy — vòng lặp dispatch poll nhanh (5s) để đăng ngay khi proxy rảnh.
 * Tương tự login-wait: user không cần bấm lại.
 */
type ProxyWaitEntry = {
  assignmentId?: string;
  projectId?: string;
  deadline: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __apmReviewProxyWait: Map<string, ProxyWaitEntry> | undefined;
}

const DEFAULT_WAIT_MS = 2 * 60 * 60_000; // 2h — đủ cover cooldown dài

function store(): Map<string, ProxyWaitEntry> {
  if (!globalThis.__apmReviewProxyWait) {
    globalThis.__apmReviewProxyWait = new Map();
  }
  return globalThis.__apmReviewProxyWait;
}

function waitKey(entry: { assignmentId?: string; projectId?: string }) {
  return entry.assignmentId ?? entry.projectId ?? "__global__";
}

export function registerProxyWait(
  opts: { assignmentId?: string; projectId?: string } = {},
  waitMs = DEFAULT_WAIT_MS,
) {
  const key = waitKey(opts);
  store().set(key, {
    assignmentId: opts.assignmentId,
    projectId: opts.projectId,
    deadline: Date.now() + waitMs,
  });
}

export function clearProxyWait(opts?: { assignmentId?: string; projectId?: string }) {
  if (!opts) {
    store().clear();
    return;
  }
  store().delete(waitKey(opts));
}

export function drainProxyWaits(now = Date.now()): ProxyWaitEntry[] {
  const map = store();
  const live: ProxyWaitEntry[] = [];
  for (const [id, entry] of map) {
    if (entry.deadline < now) {
      map.delete(id);
      continue;
    }
    live.push(entry);
  }
  return live;
}

export function hasProxyWaits(): boolean {
  return store().size > 0;
}
