import { Modal, Table, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useState } from "react";
import { api } from "../api";

type Job = {
  id: string;
  taskCode: string;
  status: string;
  durationMs?: number | null;
  error?: string | null;
  result?: {
    ok?: boolean;
    exitIp?: string | null;
    proxy?: string;
    userAgent?: string;
    browserVersion?: string;
    title?: string;
    url?: string;
    checkedAt?: string;
  } | null;
  createdAt: string;
  profile?: { account?: { email?: string }; browserVersion?: string | null };
};

export function JobsPage() {
  const [detail, setDetail] = useState<Job | null>(null);
  const { data = [], isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<Job[]>("/jobs?limit=100"),
    refetchInterval: 5000,
  });

  return (
    <>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        onRow={(r) => ({
          onClick: () => setDetail(r),
          style: { cursor: "pointer" },
        })}
        columns={[
          { title: "Email", render: (_, r) => r.profile?.account?.email || "—" },
          { title: "Task", dataIndex: "taskCode", width: 140 },
          {
            title: "Status",
            dataIndex: "status",
            width: 120,
            render: (v: string) => (
              <Tag color={v === "COMPLETED" ? "green" : v === "FAILED" ? "red" : "blue"}>
                {v}
              </Tag>
            ),
          },
          {
            title: "Exit IP",
            width: 140,
            render: (_, r) => r.result?.exitIp || "—",
          },
          {
            title: "Proxy",
            width: 160,
            render: (_, r) => r.result?.proxy || "—",
          },
          {
            title: "Duration",
            dataIndex: "durationMs",
            width: 90,
            render: (v?: number | null) => (v != null ? `${Math.round(v / 1000)}s` : "—"),
          },
          { title: "Error", dataIndex: "error", ellipsis: true },
          {
            title: "Created",
            dataIndex: "createdAt",
            width: 170,
            render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
          },
        ]}
      />

      <Modal
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={null}
        title="Chi tiết job"
        width={640}
      >
        {detail && (
          <div style={{ display: "grid", gap: 8 }}>
            <div>
              <Typography.Text type="secondary">Task</Typography.Text>
              <div>{detail.taskCode}</div>
            </div>
            <div>
              <Typography.Text type="secondary">Status</Typography.Text>
              <div>{detail.status}</div>
            </div>
            {detail.result?.exitIp && (
              <div>
                <Typography.Text type="secondary">Exit IP (qua proxy)</Typography.Text>
                <div>
                  <Typography.Text code>{detail.result.exitIp}</Typography.Text>
                </div>
              </div>
            )}
            {detail.result?.proxy && (
              <div>
                <Typography.Text type="secondary">Proxy</Typography.Text>
                <div>{detail.result.proxy}</div>
              </div>
            )}
            {detail.result?.browserVersion && (
              <div>
                <Typography.Text type="secondary">Browser</Typography.Text>
                <div>{detail.result.browserVersion}</div>
              </div>
            )}
            {detail.result?.userAgent && (
              <div>
                <Typography.Text type="secondary">User-Agent</Typography.Text>
                <div style={{ wordBreak: "break-all" }}>{detail.result.userAgent}</div>
              </div>
            )}
            {detail.error && (
              <div>
                <Typography.Text type="secondary">Error</Typography.Text>
                <div style={{ color: "#cf1322" }}>{detail.error}</div>
              </div>
            )}
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
              Click hàng để xem chi tiết. Check browser → IP + UA lưu vào đây.
            </Typography.Paragraph>
          </div>
        )}
      </Modal>
    </>
  );
}
