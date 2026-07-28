import { Button, Card, Form, Input, Typography, message } from "antd";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { useUiStore } from "../store";

export function LoginPage() {
  const { accessToken, setAuth } = useUiStore();
  if (accessToken) return <Navigate to="/" replace />;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <Card style={{ width: 380 }}>
        <Typography.Title level={3}>Đăng nhập APM</Typography.Title>
        <Typography.Paragraph type="secondary">
          Admin mặc định: admin@apm.local / Admin@123
        </Typography.Paragraph>
        <Form
          layout="vertical"
          onFinish={async (values) => {
            try {
              const res = await api<{
                accessToken: string;
                refreshToken: string;
                user: { email: string; role: string };
              }>("/auth/login", {
                method: "POST",
                body: JSON.stringify(values),
              });
              setAuth({
                accessToken: res.accessToken,
                refreshToken: res.refreshToken,
                email: res.user.email,
                role: res.user.role,
              });
            } catch (e) {
              message.error(e instanceof Error ? e.message : "Login failed");
            }
          }}
        >
          <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            Login
          </Button>
        </Form>
      </Card>
    </div>
  );
}
