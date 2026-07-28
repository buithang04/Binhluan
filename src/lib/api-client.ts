/** Parse JSON API response; surface non-JSON / network failures clearly. */
export async function readApiJson<T = Record<string, unknown>>(
  res: Response,
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      res.ok
        ? "Phản hồi máy chủ không hợp lệ"
        : `Máy chủ lỗi ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
}
