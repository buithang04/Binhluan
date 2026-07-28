import { Layout, Menu, Button, Switch, Typography, Space } from "antd";
import {
  DashboardOutlined,
  UserOutlined,
  CloudServerOutlined,
  ProfileOutlined,
  ClusterOutlined,
  UnorderedListOutlined,
  LogoutOutlined,
} from "@ant-design/icons";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useUiStore } from "./store";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { AccountsPage } from "./pages/AccountsPage";
import { ProxiesPage } from "./pages/ProxiesPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { JobsPage } from "./pages/JobsPage";
import { WorkersPage } from "./pages/WorkersPage";
import { LiveBrowserSync } from "./components/LiveBrowserSync";

const { Header, Sider, Content } = Layout;

function Shell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { email, darkMode, toggleDark, clearAuth } = useUiStore();
  const selected = location.pathname === "/" ? "/" : `/${location.pathname.split("/")[1]}`;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <LiveBrowserSync />
      <Sider breakpoint="lg" collapsedWidth={64} theme={darkMode ? "dark" : "light"}>
        <div style={{ padding: 16, fontWeight: 700 }}>APM (legacy)</div>
        <div style={{ padding: "0 16px 12px", fontSize: 11, opacity: 0.75 }}>
          UI chính: localhost:3000
        </div>
        <Menu
          theme={darkMode ? "dark" : "light"}
          mode="inline"
          selectedKeys={[selected]}
          items={[
            { key: "/", icon: <DashboardOutlined />, label: <Link to="/">Dashboard</Link> },
            { key: "/accounts", icon: <UserOutlined />, label: <Link to="/accounts">Accounts</Link> },
            { key: "/proxies", icon: <CloudServerOutlined />, label: <Link to="/proxies">Proxies</Link> },
            { key: "/profiles", icon: <ProfileOutlined />, label: <Link to="/profiles">Profiles</Link> },
            { key: "/jobs", icon: <UnorderedListOutlined />, label: <Link to="/jobs">Jobs</Link> },
            { key: "/workers", icon: <ClusterOutlined />, label: <Link to="/workers">Workers</Link> },
          ]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "transparent",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingInline: 24,
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            Automation Profile Manager
          </Typography.Title>
          <Space>
            <Typography.Text type="secondary">{email}</Typography.Text>
            <Switch checked={darkMode} onChange={toggleDark} />
            <Button icon={<LogoutOutlined />} onClick={clearAuth}>
              Logout
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: 24 }}>{children}</Content>
      </Layout>
    </Layout>
  );
}

function Private({ children }: { children: React.ReactNode }) {
  const token = useUiStore((s) => s.accessToken);
  if (!token) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Private><DashboardPage /></Private>} />
      <Route path="/accounts" element={<Private><AccountsPage /></Private>} />
      <Route path="/proxies" element={<Private><ProxiesPage /></Private>} />
      <Route path="/profiles" element={<Private><ProfilesPage /></Private>} />
      <Route path="/jobs" element={<Private><JobsPage /></Private>} />
      <Route path="/workers" element={<Private><WorkersPage /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
