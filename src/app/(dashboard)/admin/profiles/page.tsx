"use client";

import { ApmAdminTable } from "@/components/ApmAdminTable";
import { StatusLight } from "@/components/StatusLight";

export default function AdminProfilesPage() {
  return (
    <ApmAdminTable
      title="Browser Profiles"
      active="/admin/profiles"
      path="/profiles"
      columns={[
        {
          key: "browserIndex",
          label: "#",
          render: (r) => `#${r.browserIndex}`,
        },
        {
          key: "account",
          label: "Email",
          render: (r) => String((r.account as { email?: string })?.email ?? "—"),
        },
        {
          key: "status",
          label: "Status",
          render: (r) => <StatusLight value={r.status} kind="status" />,
        },
        {
          key: "browserAlive",
          label: "Browser",
          render: (r) => (
            <StatusLight value={r.browserAlive ? "alive" : "off"} kind="alive" />
          ),
        },
        {
          key: "proxy",
          label: "Proxy",
          render: (r) => {
            const p = r.proxy as { host?: string; port?: number } | undefined;
            return p ? `${p.host}:${p.port}` : "—";
          },
        },
      ]}
    />
  );
}
