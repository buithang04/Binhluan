"use client";

import { ApmAdminTable } from "@/components/ApmAdminTable";
import { StatusLight } from "@/components/StatusLight";

export default function AdminProxiesPage() {
  return (
    <ApmAdminTable
      title="Proxies"
      active="/admin/proxies"
      path="/proxies"
      columns={[
        {
          key: "host",
          label: "Host",
          render: (r) => `${r.host}:${r.port}`,
        },
        { key: "country", label: "Country" },
        {
          key: "health",
          label: "Health",
          render: (r) => <StatusLight value={r.health} kind="health" />,
        },
        {
          key: "status",
          label: "Status",
          render: (r) => <StatusLight value={r.status} kind="status" />,
        },
        {
          key: "available",
          label: "Queue",
          render: (r) => {
            if (r.locked) return "🔒 lock";
            if (r.cooling) return "⏳ cooldown";
            if (r.available) return "sẵn sàng";
            return "—";
          },
        },
        {
          key: "currentProfiles",
          label: "Profiles",
          render: (r) => `${r.currentProfiles ?? 0}/${r.maxProfiles ?? "—"}`,
        },
      ]}
    />
  );
}
