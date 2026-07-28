"use client";

import { ApmAdminTable } from "@/components/ApmAdminTable";
import { StatusLight } from "@/components/StatusLight";

export default function AdminJobsPage() {
  return (
    <ApmAdminTable
      title="Jobs"
      active="/admin/jobs"
      path="/jobs?limit=50"
      columns={[
        { key: "taskCode", label: "Task" },
        {
          key: "status",
          label: "Status",
          render: (r) => <StatusLight value={r.status} kind="status" />,
        },
        {
          key: "profile",
          label: "Profile",
          render: (r) => {
            const p = r.profile as
              | { browserIndex?: number; account?: { email?: string } }
              | undefined;
            return p ? `#${p.browserIndex} ${p.account?.email ?? ""}` : "—";
          },
        },
        { key: "createdAt", label: "Created" },
      ]}
    />
  );
}
