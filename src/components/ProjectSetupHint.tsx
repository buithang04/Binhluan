"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Sau tạo dự án (?setup=1): gợi ý bước nội dung + ảnh và cuộn tới đó. */
export function ProjectSetupHint() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const setup = searchParams.get("setup") === "1";
  const [visible, setVisible] = useState(setup);

  useEffect(() => {
    if (!setup) return;
    setVisible(true);
    const t = window.setTimeout(() => {
      document.getElementById("project-content")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 120);
    return () => window.clearTimeout(t);
  }, [setup]);

  function dismiss() {
    setVisible(false);
    router.replace(pathname, { scroll: false });
  }

  if (!visible) return null;

  return (
    <div className="rounded-[var(--radius)] border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--accent-ink)]">
            Tiếp theo · bước nội dung & ảnh
          </p>
          <p className="mt-1 text-sm text-[var(--ink)]">
            Sinh{" "}
            <a href="#project-content" className="link-accent font-medium">
              nội dung bình luận theo sao
            </a>
            , rồi thêm ảnh vào{" "}
            <a href="#project-media" className="link-accent font-medium">
              thư viện ảnh
            </a>
            .
          </p>
        </div>
        <button type="button" className="btn btn-secondary !py-1.5 text-sm" onClick={dismiss}>
          Đã hiểu
        </button>
      </div>
    </div>
  );
}
