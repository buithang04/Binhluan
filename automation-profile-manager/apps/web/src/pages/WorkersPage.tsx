import { Table, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { api } from "../api";

type Worker = {
  id: string;
  hostname: string;
  status: string;
  concurrency: number;
  runningJobs: number;
  memPercent?: number | null;
  lastHeartbeat: string;
};

export function WorkersPage() {
  const { data = [], isLoading } = useQuery({
    queryKey: ["workers"],
    queryFn: () => api<Worker[]>("/workers"),
    refetchInterval: 5000,
  });

  return (
    <Table
      rowKey="id"
      loading={isLoading}
      dataSource={data}
      columns={[
        { title: "ID", dataIndex: "id", ellipsis: true },
        { title: "Host", dataIndex: "hostname" },
        {
          title: "Status",
          dataIndex: "status",
          render: (v: string) => <Tag color={v === "ONLINE" ? "green" : "default"}>{v}</Tag>,
        },
        { title: "Concurrency", dataIndex: "concurrency" },
        { title: "Running", dataIndex: "runningJobs" },
        {
          title: "Mem %",
          dataIndex: "memPercent",
          render: (v?: number | null) => (v != null ? `${v}%` : "—"),
        },
        {
          title: "Heartbeat",
          dataIndex: "lastHeartbeat",
          render: (v: string) => dayjs(v).format("HH:mm:ss"),
        },
      ]}
    />
  );
}
