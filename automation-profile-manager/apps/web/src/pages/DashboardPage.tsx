import { Card, Col, Row, Statistic } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

type Overview = {
  accounts: number;
  proxies: number;
  profilesByStatus: Record<string, number>;
  jobsLast24h: number;
  workersOnline: number;
  queue: { waiting: number; active: number; failed: number };
};

export function DashboardPage() {
  const { data } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api<Overview>("/stats/overview"),
    refetchInterval: 5000,
  });

  const ready = data?.profilesByStatus?.READY ?? 0;
  const running = data?.profilesByStatus?.RUNNING ?? 0;
  const queued = data?.profilesByStatus?.QUEUED ?? 0;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} md={8} lg={6}><Card><Statistic title="Accounts" value={data?.accounts ?? 0} /></Card></Col>
      <Col xs={24} md={8} lg={6}><Card><Statistic title="Proxies" value={data?.proxies ?? 0} /></Card></Col>
      <Col xs={24} md={8} lg={6}><Card><Statistic title="Profiles READY" value={ready} /></Card></Col>
      <Col xs={24} md={8} lg={6}><Card><Statistic title="Running / Queued" value={`${running} / ${queued}`} /></Card></Col>
      <Col xs={24} md={8} lg={6}><Card><Statistic title="Workers online" value={data?.workersOnline ?? 0} /></Card></Col>
      <Col xs={24} md={8} lg={6}><Card><Statistic title="Queue waiting" value={data?.queue?.waiting ?? 0} /></Card></Col>
      <Col xs={24} md={8} lg={6}><Card><Statistic title="Queue active" value={data?.queue?.active ?? 0} /></Card></Col>
      <Col xs={24} md={8} lg={6}><Card><Statistic title="Jobs 24h" value={data?.jobsLast24h ?? 0} /></Card></Col>
    </Row>
  );
}
