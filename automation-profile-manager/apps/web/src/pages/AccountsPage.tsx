import {
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

type Account = {
  id: string;
  email: string;
  status: string;
  recoveryEmail?: string | null;
  hasTotp?: boolean;
  profile?: {
    id: string;
    status: string;
    browserIndex?: number;
    browserAlive?: boolean;
  } | null;
};

/** Chỉ hiển thị READY | UNREADY. */
function readyStatus(v?: string | null) {
  return v === "READY" ? "READY" : "UNREADY";
}

export function AccountsPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
    refetchInterval: 5000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["profiles"] });
    qc.invalidateQueries({ queryKey: ["proxies"] });
  };

  const create = useMutation({
    mutationFn: async (body: {
      email: string;
      password: string;
      recoveryEmail?: string;
      autoAssignProxy?: boolean;
    }) => {
      const { autoAssignProxy, ...account } = body;
      const created = await api<{ id: string }>("/accounts", {
        method: "POST",
        body: JSON.stringify(account),
      });
      if (autoAssignProxy !== false) {
        await api("/profiles/auto-assign", {
          method: "POST",
          body: JSON.stringify({ accountId: created.id }),
        });
      }
      return created;
    },
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      message.success("Đã tạo — UNREADY, đang mở Chrome login");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api(`/accounts/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      invalidate();
      setEditing(null);
      message.success("Đã cập nhật");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      message.success("Đã xóa");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const assignOne = useMutation({
    mutationFn: (accountId: string) =>
      api("/profiles/auto-assign", {
        method: "POST",
        body: JSON.stringify({ accountId }),
      }),
    onSuccess: () => {
      invalidate();
      message.success("Đã gắn proxy + mở Chrome");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const openBrowser = useMutation({
    mutationFn: (profileId: string) =>
      api(`/profiles/${profileId}/open-browser`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      invalidate();
      message.success("Đang mở lại Chrome…");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const focusBrowser = useMutation({
    mutationFn: (profileId: string) =>
      api(`/profiles/${profileId}/focus-browser`, { method: "POST", body: "{}" }),
    onSuccess: () => message.success("Đã đưa browser lên màn hình"),
    onError: (e: Error) => {
      message.error(e.message);
      invalidate();
    },
  });

  return (
    <>
      <Button type="primary" onClick={() => setCreateOpen(true)} style={{ marginBottom: 16 }}>
        Thêm account
      </Button>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        columns={[
          { title: "Email", dataIndex: "email" },
          {
            title: "Status",
            render: (_, r) => {
              const s = readyStatus(r.status);
              return <Tag color={s === "READY" ? "green" : "orange"}>{s}</Tag>;
            },
          },
          {
            title: "Browser",
            render: (_, r) =>
              r.profile?.browserIndex != null ? (
                <Space size={4}>
                  <Tag color="blue">#{r.profile.browserIndex}</Tag>
                  {r.profile.browserAlive ? (
                    <Tag
                      color="green"
                      style={{ cursor: "pointer" }}
                      onClick={() => focusBrowser.mutate(r.profile!.id)}
                      title="Bấm để hiện cửa sổ Chrome"
                    >
                      alive
                    </Tag>
                  ) : (
                    <Tag>off</Tag>
                  )}
                </Space>
              ) : (
                "—"
              ),
          },
          { title: "Recovery", dataIndex: "recoveryEmail", render: (v) => v || "—" },
          {
            title: "2FA",
            dataIndex: "hasTotp",
            width: 70,
            render: (v: boolean) => (v ? <Tag color="blue">2FA</Tag> : "—"),
          },
          {
            title: "Thao tác",
            width: 320,
            render: (_, r) => (
              <Space wrap>
                {!r.profile && (
                  <Button
                    size="small"
                    loading={assignOne.isPending}
                    onClick={() => assignOne.mutate(r.id)}
                  >
                    Gắn proxy
                  </Button>
                )}
                {r.profile && !r.profile.browserAlive && (
                  <Button
                    size="small"
                    type="primary"
                    loading={openBrowser.isPending}
                    onClick={() => openBrowser.mutate(r.profile!.id)}
                  >
                    Mở browser
                  </Button>
                )}
                <Button size="small" onClick={() => setEditing(r)}>
                  Sửa
                </Button>
                <Popconfirm
                  title="Xóa account này?"
                  description="Profile gắn kèm (nếu có) cũng sẽ bị xóa."
                  okText="Xóa"
                  cancelText="Hủy"
                  onConfirm={() => remove.mutate(r.id)}
                >
                  <Button size="small" danger loading={remove.isPending}>
                    Xóa
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={null}
        title="Thêm Google Account"
        destroyOnClose
      >
        <Form
          layout="vertical"
          initialValues={{ autoAssignProxy: true }}
          onFinish={(v) => create.mutate(v)}
        >
          <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
            <Input placeholder="google-account@gmail.com" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="totpSecret"
            label="2FA (TOTP secret)"
            extra="Dán secret Authenticator — khi login Google hỏi mã, hệ thống gọi 2fa.live"
          >
            <Input.TextArea
              rows={2}
              placeholder="bjxj pwb4 rlcl bzod …"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item name="recoveryEmail" label="Recovery email">
            <Input />
          </Form.Item>
          <Form.Item
            name="autoAssignProxy"
            label="Tự gắn proxy + mở Chrome login"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>
            Thêm
          </Button>
        </Form>
      </Modal>

      <Modal
        open={!!editing}
        onCancel={() => setEditing(null)}
        footer={null}
        title="Sửa account"
        destroyOnClose
      >
        {editing && (
          <Form
            layout="vertical"
            initialValues={{
              email: editing.email,
              recoveryEmail: editing.recoveryEmail || "",
              status: readyStatus(editing.status),
              password: "",
              totpSecret: "",
            }}
            onFinish={(v) =>
              update.mutate({
                id: editing.id,
                email: v.email,
                recoveryEmail: v.recoveryEmail || null,
                status: v.status,
                ...(v.password ? { password: v.password } : {}),
                ...(v.totpSecret?.trim() ? { totpSecret: v.totpSecret.trim() } : {}),
              })
            }
          >
            <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
              <Input />
            </Form.Item>
            <Form.Item name="password" label="Password mới (để trống = giữ nguyên)">
              <Input.Password />
            </Form.Item>
            <Form.Item
              name="totpSecret"
              label={
                editing.hasTotp
                  ? "2FA mới (để trống = giữ nguyên · đã có 2FA)"
                  : "2FA (TOTP secret)"
              }
            >
              <Input.TextArea rows={2} placeholder="bjxj pwb4 rlcl …" autoComplete="off" />
            </Form.Item>
            <Form.Item name="recoveryEmail" label="Recovery email">
              <Input />
            </Form.Item>
            <Form.Item name="status" label="Status">
              <Select options={[{ value: "UNREADY" }, { value: "READY" }]} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={update.isPending} block>
              Lưu
            </Button>
          </Form>
        )}
      </Modal>
    </>
  );
}
