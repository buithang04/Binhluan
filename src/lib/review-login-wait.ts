import "server-only";

/**
 * Registry (in-memory) các bài đang chờ account đăng nhập xong để TỰ đăng tiếp.
 * Khi bấm Đăng mà account chưa READY, hệ thống mở Chrome login (như thêm mail)
 * và ghi bài vào đây. Vòng lặp dispatch sẽ tự đăng khi profile READY —
 * user KHÔNG cần bấm Đăng lại.
 */
type WaitEntry = {
  assignmentId: string;
  projectId: string;
  /** Hết hạn chờ (ms epoch) — quá hạn thì bỏ theo dõi (login tay thất bại). */
  deadline: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __apmReviewLoginWait: Map<string, WaitEntry> | undefined;
}

const DEFAULT_WAIT_MS = 5 * 60_000;

function store(): Map<string, WaitEntry> {
  if (!globalThis.__apmReviewLoginWait) {
    globalThis.__apmReviewLoginWait = new Map();
  }
  return globalThis.__apmReviewLoginWait;
}

export function registerLoginWait(
  assignmentId: string,
  projectId: string,
  waitMs = DEFAULT_WAIT_MS,
) {
  store().set(assignmentId, {
    assignmentId,
    projectId,
    deadline: Date.now() + waitMs,
  });
}

export function clearLoginWait(assignmentId: string) {
  store().delete(assignmentId);
}

/** Danh sách bài còn trong hạn chờ; đồng thời dọn các bài quá hạn. */
export function drainLoginWaits(now = Date.now()): WaitEntry[] {
  const map = store();
  const live: WaitEntry[] = [];
  for (const [id, entry] of map) {
    if (entry.deadline < now) {
      map.delete(id);
      continue;
    }
    live.push(entry);
  }
  return live;
}

export function hasLoginWaits(): boolean {
  return store().size > 0;
}
