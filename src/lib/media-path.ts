import "server-only";

function joinOs(...parts: string[]): string {
  const cleaned = parts.map((p, i) => {
    const s = String(p);
    if (i === 0) return s.replace(/[/\\]+$/, "");
    return s.replace(/^[/\\]+|[/\\]+$/g, "");
  });
  const joined = cleaned.filter(Boolean).join("/");
  return process.platform === "win32" ? joined.replace(/\//g, "\\") : joined;
}

/** Thư mục upload trên disk (chỉ dùng server-side). */
export function uploadRoot() {
  const env = process.env.UPLOAD_DIR?.replace(/[/\\]+$/, "");
  const raw = env || joinOs(process.cwd(), "uploads");
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/")) {
    return process.platform === "win32" ? raw.replace(/\//g, "\\") : raw;
  }
  return joinOs(process.cwd(), raw.replace(/^\.[/\\]/, ""));
}

/** Đường dẫn disk tuyệt đối từ MediaAsset (filePath public là /api/uploads/...). */
export function mediaAbsolutePath(projectId: string, fileName: string) {
  return joinOs(uploadRoot(), projectId, fileName);
}
