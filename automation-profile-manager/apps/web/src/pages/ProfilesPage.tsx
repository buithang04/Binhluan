import {
  Button,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useEffect, useState } from "react";
import { api } from "../api";

dayjs.extend(relativeTime);

type Profile = {
  id: string;
  status: string;
  browserIndex: number;
  browserAlive: boolean;
  cooldownMinutes: number;
  lastRun?: string | null;
  nextRun: string;
  currentTask?: string | null;
  browserVersion?: string | null;
  account: { id: string; email: string; status?: string };
  proxy: { id: string; host: string; port: number; country?: string | null };
};

type ProxyOpt = {
  id: string;
  host: string;
  port: number;
  country?: string | null;
  health: string;
  currentProfiles: number;
  maxProfiles: number;
};

/** Chỉ hiển thị READY | UNREADY (account readiness). */
function readyStatus(profile: Profile) {
  return profile.account.status === "READY" || profile.status === "READY"
    ? "READY"
    : "UNREADY";
}

function Countdown({ nextRun }: { nextRun: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const diff = dayjs(nextRun).valueOf() - now;
  if (diff <= 0) return <Tag color="green">due</Tag>;
  const sec = Math.floor(diff / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return <Tag>{`${m}m ${s}s`}</Tag>;
}

export function ProfilesPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Profile | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api<Profile[]>("/profiles"),
    refetchInterval: 5000,
  });

  const { data: proxies = [] } = useQuery({
    queryKey: ["proxies"],
    queryFn: () => api<ProxyOpt[]>("/proxies"),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["profiles"] });
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["proxies"] });
  };

  const run = useMutation({
    mutationFn: ({ id, taskCode }: { id: string; taskCode: string }) =>
      api(`/profiles/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ taskCode }),
      }),
    onSuccess: (_data, vars) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["jobs"] });
      message.success(
        vars.taskCode === "BROWSER_CHECK"
          ? "Đang check browser"
          : "Job enqueued",
      );
    },
    onError: (e: Error) => message.error(e.message),
  });

  const openBrowser = useMutation({
    mutationFn: (id: string) =>
      api(`/profiles/${id}/open-browser`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["jobs"] });
      message.success("Đang mở lại Chrome…");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const focusBrowser = useMutation({
    mutationFn: (id: string) =>
      api(`/profiles/${id}/focus-browser`, { method: "POST", body: "{}" }),
    onSuccess: () => message.success("Đã đưa browser lên màn hình"),
    onError: (e: Error) => {
      message.error(e.message);
      invalidate();
    },
  });

  const autoAssignAll = useMutation({
    mutationFn: () =>
      api<{ assigned: number; failed: number }>("/profiles/auto-assign", {
        method: "POST",
        body: JSON.stringify({ allUnassigned: true }),
      }),
    onSuccess: (res) => {
      invalidate();
      message.success(`Đã gắn ${res.assigned} account · lỗi ${res.failed}`);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api(`/profiles/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      invalidate();
      setEditing(null);
      message.success("Đã cập nhật profile");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/profiles/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      message.success("Đã xóa profile");
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          loading={autoAssignAll.isPending}
          onClick={() => autoAssignAll.mutate()}
        >
          Tự gắn account chưa có proxy
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        columns={[
          {
            title: "#",
            dataIndex: "browserIndex",
            width: 70,
            render: (v: number) => <Tag color="blue">#{v}</Tag>,
          },
          { title: "Email", render: (_, r) => r.account.email },
          {
            title: "Proxy",
            render: (_, r) =>
              `${r.proxy.host}:${r.proxy.port}${r.proxy.country ? ` (${r.proxy.country})` : ""}`,
          },
          {
            title: "Status",
            render: (_, r) => {
              const s = readyStatus(r);
              return <Tag color={s === "READY" ? "green" : "orange"}>{s}</Tag>;
            },
          },
          {
            title: "Browser",
            render: (_, r) =>
              r.browserAlive ? (
                <Tag
                  color="green"
                  style={{ cursor: "pointer" }}
                  onClick={() => focusBrowser.mutate(r.id)}
                  title="Bấm để hiện cửa sổ Chrome"
                >
                  alive
                </Tag>
              ) : (
                <Tag>off</Tag>
              ),
          },
          {
            title: "Countdown",
            render: (_, r) => <Countdown nextRun={r.nextRun} />,
          },
          {
            title: "Last run",
            dataIndex: "lastRun",
            render: (v?: string | null) => (v ? dayjs(v).fromNow() : "—"),
          },
          {
            title: "Thao tác",
            width: 420,
            render: (_, r) => (
              <Space wrap>
                {!r.browserAlive && (
                  <Button
                    size="small"
                    type="primary"
                    loading={openBrowser.isPending}
                    onClick={() => openBrowser.mutate(r.id)}
                  >
                    Mở browser
                  </Button>
                )}
                <Button
                  size="small"
                  loading={run.isPending}
                  onClick={() => run.mutate({ id: r.id, taskCode: "BROWSER_CHECK" })}
                >
                  Check browser
                </Button>
                <Button
                  size="small"
                  disabled={readyStatus(r) !== "READY" || !r.browserAlive}
                  loading={run.isPending}
                  onClick={() => run.mutate({ id: r.id, taskCode: "HEALTHCHECK" })}
                >
                  Run
                </Button>
                <Button size="small" onClick={() => setEditing(r)}>
                  Sửa
                </Button>
                <Popconfirm
                  title="Xóa profile này?"
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
        open={!!editing}
        onCancel={() => setEditing(null)}
        footer={null}
        title="Sửa profile"
        destroyOnClose
      >
        {editing && (
          <Form
            layout="vertical"
            initialValues={{
              proxyId: editing.proxy?.id,
              cooldownMinutes: editing.cooldownMinutes,
              status: readyStatus(editing),
            }}
            onFinish={(v) =>
              update.mutate({
                id: editing.id,
                proxyId: v.proxyId || null,
                cooldownMinutes: v.cooldownMinutes,
                status: v.status,
              })
            }
          >
            <Form.Item label="Email">
              <div>{editing.account.email}</div>
            </Form.Item>
            <Form.Item name="proxyId" label="Proxy sticky (tuỳ chọn — khuyến nghị để trống)">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={proxies.map((p) => ({
                  value: p.id,
                  label: `${p.host}:${p.port} · ${p.health} · ${p.currentProfiles}/${p.maxProfiles}${
                    p.country ? ` · ${p.country}` : ""
                  }`,
                }))}
              />
            </Form.Item>
            <Form.Item name="cooldownMinutes" label="Cooldown (phút)">
              <InputNumber style={{ width: "100%" }} min={1} max={10080} />
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
