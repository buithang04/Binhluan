import {
  CheckCircleOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  GiftOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

/** Tick every 1s so relative times / countdown update live. */
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

type Proxy = {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username?: string | null;
  password?: string | null;
  country?: string | null;
  city?: string | null;
  maxProfiles: number;
  currentProfiles: number;
  status: string;
  health?: string | null;
  lastCheckedAt?: string | null;
  note?: string | null;
};

const COUNTRY_NAMES: Record<string, string> = {
  GB: "United Kingdom",
  US: "United States",
  ES: "Spain",
  PL: "Poland",
  JP: "Japan",
  DE: "Germany",
  FR: "France",
  NL: "Netherlands",
  IT: "Italy",
  CA: "Canada",
  AU: "Australia",
  SG: "Singapore",
  VN: "Vietnam",
  KR: "South Korea",
  IN: "India",
  BR: "Brazil",
};

function flagEmoji(code?: string | null) {
  if (!code || code.length !== 2) return "🌐";
  const cc = code.toUpperCase();
  return String.fromCodePoint(
    ...[...cc].map((c) => 127397 + c.charCodeAt(0)),
  );
}

function countryName(code?: string | null) {
  if (!code) return "—";
  const cc = code.toUpperCase();
  if (COUNTRY_NAMES[cc]) return COUNTRY_NAMES[cc];
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || cc;
  } catch {
    return cc;
  }
}

function relativeTime(iso?: string | null, now = Date.now()) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ${min % 60}m ago`;
  return new Date(iso).toLocaleString();
}

function nextSyncLabel(
  lastFinishedAt: string | null | undefined,
  intervalSec: number,
  now: number,
  running?: boolean,
  cooldownUntil?: string | null,
) {
  if (running) return "đang sync…";
  if (cooldownUntil) {
    const left = Math.ceil((new Date(cooldownUntil).getTime() - now) / 1000);
    if (left > 0) return `rate limit · còn ${left}s`;
  }
  if (!lastFinishedAt) return "chưa sync";
  const elapsed = Math.floor((now - new Date(lastFinishedAt).getTime()) / 1000);
  const left = Math.max(0, intervalSec - elapsed);
  if (left <= 0) return "sắp sync…";
  return `sync sau ${left}s`;
}

function SecretCell({ value }: { value?: string | null }) {
  const [show, setShow] = useState(false);
  if (!value) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={4}>
      <Typography.Text style={{ margin: 0, fontFamily: "monospace" }}>
        {show ? value : "••••••••"}
      </Typography.Text>
      <Button
        type="text"
        size="small"
        icon={show ? <EyeInvisibleOutlined /> : <EyeOutlined />}
        onClick={() => setShow((s) => !s)}
      />
    </Space>
  );
}

function healthTag(health?: string | null) {
  if (health === "WORKING") {
    return (
      <Tag icon={<CheckCircleOutlined />} color="success">
        Working
      </Tag>
    );
  }
  if (health === "FAILED") {
    return <Tag color="error">Failed</Tag>;
  }
  return <Tag>Unknown</Tag>;
}

export function ProxiesPage() {
  const qc = useQueryClient();
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Proxy | null>(null);
  const [connectionMethod, setConnectionMethod] = useState<"direct" | "backbone">(
    "direct",
  );
  const [selected, setSelected] = useState<string[]>([]);

  const {
    data = [],
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["proxies"],
    queryFn: () => api<Proxy[]>("/proxies"),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
    retry: 2,
  });

  const { data: syncStatus } = useQuery({
    queryKey: ["proxies-sync-status"],
    queryFn: () =>
      api<{
        enabled: boolean;
        intervalSec: number;
        running: boolean;
        cooldownUntil: string | null;
        lastFinishedAt: string | null;
        lastError: string | null;
        lastResult: { imported: number; updated: number; skipped: number } | null;
        hasApiToken?: boolean;
        apiTokenHint?: string | null;
        apiBaseUrl?: string;
        mode?: string;
      }>("/proxies/sync/status"),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
    retry: 2,
  });

  const create = useMutation({
    mutationFn: (body: unknown) =>
      api("/proxies", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      setOpen(false);
      message.success("Đã thêm proxy");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api(`/proxies/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      setEditing(null);
      message.success("Đã cập nhật proxy");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const importWebshare = useMutation({
    mutationFn: (body: unknown) =>
      api<{ imported: number; updated: number; skipped: number }>(
        "/proxies/import/webshare",
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      setImportOpen(false);
      message.success(
        `Webshare: +${res.imported} mới, ${res.updated} cập nhật, ${res.skipped} bỏ qua`,
      );
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/proxies/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      message.success("Đã xóa proxy");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const workingCount = useMemo(
    () => data.filter((p) => p.health === "WORKING").length,
    [data],
  );

  const downloadList = () => {
    const rows = (selected.length
      ? data.filter((p) => selected.includes(p.id))
      : data
    ).map(
      (p) =>
        `${p.host}:${p.port}:${p.username || ""}:${p.password || ""}`,
    );
    if (!rows.length) {
      message.warning("Không có proxy để tải");
      return;
    }
    const blob = new Blob([rows.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "proxies.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="Không tải được danh sách proxy"
          description={error instanceof Error ? error.message : "Lỗi mạng / hết phiên đăng nhập"}
          action={
            <Button size="small" loading={isFetching} onClick={() => refetch()}>
              Thử lại
            </Button>
          }
        />
      )}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Webshare API"
        description={
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>
              <b>Endpoint:</b>{" "}
              <Typography.Text code copyable style={{ fontSize: 12 }}>
                {syncStatus?.apiBaseUrl ||
                  "https://proxy.webshare.io/api/v2/proxy/list/"}
              </Typography.Text>
            </div>
            <div>
              <b>Token (.env):</b>{" "}
              {syncStatus?.hasApiToken
                ? `đã cấu hình ${syncStatus.apiTokenHint || ""}`
                : "chưa có — thêm WEBSHARE_API_TOKEN vào apps/api/.env"}
            </div>
            <div style={{ color: "#666", marginTop: 4 }}>
              Đổi token/URL cố định trong{" "}
              <code>automation-profile-manager/apps/api/.env</code> (
              <code>WEBSHARE_API_TOKEN</code>, <code>WEBSHARE_API_BASE</code>) rồi{" "}
              <code>pm2 restart binhluan --update-env</code>. Sync tay: nút Sync
              Webshare (có ô dán token tạm).
            </div>
          </div>
        }
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <Space style={{ marginBottom: 8 }} wrap>
            <GiftOutlined style={{ color: "#52c41a" }} />
            <Typography.Text>
              {data.length} proxies · {workingCount} working
            </Typography.Text>
            {syncStatus?.enabled ? (
              <Typography.Text type="secondary">
                · auto-sync mỗi {syncStatus.intervalSec}s ·{" "}
                {nextSyncLabel(
                  syncStatus.lastFinishedAt,
                  syncStatus.intervalSec,
                  now,
                  syncStatus.running,
                  syncStatus.cooldownUntil,
                )}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">
                · auto-sync tắt (cần WEBSHARE_API_TOKEN)
              </Typography.Text>
            )}
          </Space>
          <div>
            <Space wrap>
              <Button icon={<DownloadOutlined />} onClick={downloadList}>
                Download
              </Button>
              <Button
                icon={<SyncOutlined />}
                onClick={() => setImportOpen(true)}
                loading={importWebshare.isPending}
              >
                Sync Webshare
              </Button>
              <Button type="primary" onClick={() => setOpen(true)}>
                Thêm proxy
              </Button>
              {selected.length > 0 && (
                <Popconfirm
                  title={`Xóa ${selected.length} proxy đã chọn?`}
                  okText="Xóa"
                  cancelText="Hủy"
                  onConfirm={async () => {
                    for (const id of selected) {
                      await remove.mutateAsync(id);
                    }
                    setSelected([]);
                  }}
                >
                  <Button danger>Xóa đã chọn ({selected.length})</Button>
                </Popconfirm>
              )}
            </Space>
          </div>
        </div>
        <div>
          <Typography.Text type="secondary" style={{ marginRight: 8 }}>
            Connection Method
          </Typography.Text>
          <Select
            value={connectionMethod}
            onChange={setConnectionMethod}
            style={{ width: 200 }}
            options={[
              { value: "direct", label: "Direct Connection" },
              { value: "backbone", label: "Backbone Connection" },
            ]}
          />
        </div>
      </div>

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
        }}
        pagination={{
          pageSize: 10,
          showSizeChanger: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
        }}
        columns={[
          {
            title: "Proxy Address",
            dataIndex: "host",
            render: (v: string) => (
              <Typography.Text style={{ fontFamily: "monospace" }}>{v}</Typography.Text>
            ),
          },
          { title: "Port", dataIndex: "port", width: 80 },
          {
            title: "Username",
            dataIndex: "username",
            render: (v: string) =>
              v ? (
                <Typography.Text style={{ fontFamily: "monospace" }}>{v}</Typography.Text>
              ) : (
                "—"
              ),
          },
          {
            title: "Password",
            dataIndex: "password",
            render: (v: string) => <SecretCell value={v} />,
          },
          {
            title: "Last Checked",
            dataIndex: "lastCheckedAt",
            width: 150,
            render: (v: string) => (
              <Typography.Text type="secondary">
                {relativeTime(v, now)}
              </Typography.Text>
            ),
          },
          {
            title: "Status",
            dataIndex: "health",
            width: 120,
            render: (v: string) => healthTag(v),
          },
          {
            title: "Country",
            dataIndex: "country",
            render: (code: string) =>
              code ? (
                <Space size={8}>
                  <span>{flagEmoji(code)}</span>
                  <span>{countryName(code)}</span>
                </Space>
              ) : (
                "—"
              ),
          },
          {
            title: "City",
            dataIndex: "city",
            render: (v: string) => v || "—",
          },
          {
            title: "Thao tác",
            width: 200,
            fixed: "right",
            render: (_, r) => (
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `${r.host}:${r.port}:${r.username || ""}:${r.password || ""}`,
                    );
                    message.success("Copied");
                  }}
                >
                  Copy
                </Button>
                <Button size="small" onClick={() => setEditing(r)}>
                  Sửa
                </Button>
                <Popconfirm
                  title="Xóa proxy này?"
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
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        title="Thêm proxy"
        destroyOnClose
      >
        <Form
          layout="vertical"
          initialValues={{ protocol: "http", maxProfiles: 10, status: "ACTIVE" }}
          onFinish={(v) => create.mutate(v)}
        >
          <Form.Item name="host" label="Proxy Address" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="port" label="Port" rules={[{ required: true }]}>
            <InputNumber style={{ width: "100%" }} min={1} max={65535} />
          </Form.Item>
          <Form.Item name="protocol" label="Protocol">
            <Select options={[{ value: "http" }, { value: "https" }, { value: "socks5" }]} />
          </Form.Item>
          <Form.Item name="country" label="Country code">
            <Input placeholder="US" maxLength={2} />
          </Form.Item>
          <Form.Item name="city" label="City">
            <Input />
          </Form.Item>
          <Form.Item name="maxProfiles" label="Max profiles">
            <InputNumber style={{ width: "100%" }} min={1} />
          </Form.Item>
          <Form.Item name="username" label="Username">
            <Input />
          </Form.Item>
          <Form.Item name="password" label="Password">
            <Input.Password />
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
        title="Sửa proxy"
        destroyOnClose
      >
        {editing && (
          <Form
            layout="vertical"
            initialValues={{
              host: editing.host,
              port: editing.port,
              protocol: editing.protocol,
              country: editing.country || "",
              city: editing.city || "",
              maxProfiles: editing.maxProfiles,
              status: editing.status,
              username: editing.username || "",
              password: "",
            }}
            onFinish={(v) =>
              update.mutate({
                id: editing.id,
                host: v.host,
                port: v.port,
                protocol: v.protocol,
                country: v.country || null,
                city: v.city || null,
                maxProfiles: v.maxProfiles,
                status: v.status,
                ...(v.username !== undefined ? { username: v.username || null } : {}),
                ...(v.password ? { password: v.password } : {}),
              })
            }
          >
            <Form.Item name="host" label="Proxy Address" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="port" label="Port" rules={[{ required: true }]}>
              <InputNumber style={{ width: "100%" }} min={1} max={65535} />
            </Form.Item>
            <Form.Item name="protocol" label="Protocol">
              <Select options={[{ value: "http" }, { value: "https" }, { value: "socks5" }]} />
            </Form.Item>
            <Form.Item name="country" label="Country code">
              <Input maxLength={2} />
            </Form.Item>
            <Form.Item name="city" label="City">
              <Input />
            </Form.Item>
            <Form.Item name="maxProfiles" label="Max profiles">
              <InputNumber style={{ width: "100%" }} min={1} />
            </Form.Item>
            <Form.Item name="status" label="Status">
              <Select options={[{ value: "ACTIVE" }, { value: "DISABLED" }]} />
            </Form.Item>
            <Form.Item name="username" label="Username">
              <Input />
            </Form.Item>
            <Form.Item name="password" label="Password mới (để trống = giữ nguyên)">
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={update.isPending} block>
              Lưu
            </Button>
          </Form>
        )}
      </Modal>

      <Modal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        footer={null}
        title="Sync từ Webshare"
      >
        <p style={{ color: "#666", marginBottom: 16 }}>
          Đồng bộ list + status (Working) từ Webshare API. Mode:{" "}
          <b>{connectionMethod}</b>.
        </p>
        <Form
          layout="vertical"
          initialValues={{ maxProfiles: 10, onlyValid: true }}
          onFinish={(v) =>
            importWebshare.mutate({
              maxProfiles: v.maxProfiles,
              onlyValid: v.onlyValid,
              mode: connectionMethod,
              apiToken: v.apiToken?.trim() || undefined,
            })
          }
        >
          <Form.Item name="apiToken" label="API Token">
            <Input.Password placeholder="Để trống nếu dùng env WEBSHARE_API_TOKEN" />
          </Form.Item>
          <Form.Item name="maxProfiles" label="Max profiles / proxy">
            <InputNumber style={{ width: "100%" }} min={1} />
          </Form.Item>
          <Form.Item name="onlyValid" label="Chỉ proxy Working" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={importWebshare.isPending}
            block
          >
            Sync
          </Button>
        </Form>
      </Modal>
    </>
  );
}
