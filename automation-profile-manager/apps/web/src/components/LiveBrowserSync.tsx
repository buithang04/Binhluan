import { notification } from "antd";
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useUiStore } from "../store";

type LiveEvent = {
  id: number;
  at: string;
  type: string;
  message: string;
  browserIndex?: number;
  email?: string;
  status?: string;
};

/** Poll /events/live và hiện toast khi browser mở / READY / tắt. */
export function LiveBrowserSync() {
  const token = useUiStore((s) => s.accessToken);
  const qc = useQueryClient();
  const afterId = useRef(0);
  const seeded = useRef(false);

  const { data } = useQuery({
    queryKey: ["live-events"],
    queryFn: () =>
      api<{ events: LiveEvent[]; latestId: number }>(
        `/events/live?afterId=${afterId.current}`,
      ),
    enabled: Boolean(token),
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (!data) return;
    // Lần đầu chỉ neo cursor — tránh spam toast sự kiện cũ
    if (!seeded.current) {
      seeded.current = true;
      afterId.current = data.latestId || 0;
      return;
    }
    if (!data.events?.length) return;
    let changed = false;
    for (const ev of data.events) {
      if (ev.id <= afterId.current) continue;
      changed = true;
      const type =
        ev.type === "browser.ready"
          ? "success"
          : ev.type === "browser.closed"
            ? "warning"
            : "info";
      notification[type]({
        message:
          ev.type === "browser.ready"
            ? "READY"
            : ev.type === "browser.closed"
              ? "Browser tắt"
              : "Browser sync",
        description: ev.message,
        placement: "topRight",
        duration: 4,
      });
    }
    afterId.current = Math.max(afterId.current, data.latestId || 0);
    if (changed) {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["profiles"] });
    }
  }, [data, qc]);

  return null;
}
