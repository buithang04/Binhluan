"use client";

import { useEffect, useRef } from "react";
import { apmFetch } from "@/lib/apm-client";

type LiveEvent = {
  id: number;
  type: string;
  message: string;
};

/** Poll /events/live — refresh danh sách account khi browser READY/mở/đóng. */
export function AdminLiveBrowserSync({
  token,
  enabled,
  onChange,
}: {
  token: string | null | undefined;
  enabled: boolean;
  onChange: () => void;
}) {
  const afterId = useRef(0);
  const seeded = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!token || !enabled) return;

    let cancelled = false;

    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const data = await apmFetch<{ events: LiveEvent[]; latestId: number }>(
          `/events/live?afterId=${afterId.current}`,
          token,
        );
        if (cancelled) return;

        if (!seeded.current) {
          seeded.current = true;
          afterId.current = data.latestId || 0;
          return;
        }

        if (!data.events?.length) return;

        const changed = data.events.some((ev) => ev.type.startsWith("browser."));
        afterId.current = Math.max(afterId.current, data.latestId || 0);
        if (changed) onChangeRef.current();
      } catch {
        /* token/network — bỏ qua, poll backup vẫn chạy */
      }
    };

    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [token, enabled]);

  return null;
}
