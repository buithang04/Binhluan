import type { Frame, Page } from "puppeteer";

/**
 * Chạy trong page context — patch webdriver / chrome / plugins / WebGL / permissions.
 * Áp dụng cả main frame và iframe (Google challenge hay tạo iframe ẩn).
 */
function stealthInPage() {
  try {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => undefined,
      configurable: true,
    });
  } catch {
    /* ignore */
  }

  try {
    const w = window as Window & { chrome?: unknown };
    w.chrome = w.chrome || {
      runtime: {},
      loadTimes: () => ({}),
      csi: () => ({}),
      app: { isInstalled: false },
    };
  } catch {
    /* ignore */
  }

  try {
    Object.defineProperty(navigator, "languages", {
      get: () => ["vi-VN", "vi", "en-US", "en"],
      configurable: true,
    });
  } catch {
    /* ignore */
  }

  try {
    const pluginData = [
      { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    ];
    const plugins = pluginData.map((p) => {
      const mime = {
        type: "application/pdf",
        suffixes: "pdf",
        description: p.description,
        enabledPlugin: null as unknown,
      };
      const plugin = {
        name: p.name,
        filename: p.filename,
        description: p.description,
        length: 1,
        0: mime,
        item: (n: number) => (n === 0 ? mime : null),
        namedItem: () => mime,
      };
      mime.enabledPlugin = plugin;
      return plugin;
    }) as unknown as PluginArray;
    (plugins as unknown as { item: (i: number) => unknown; namedItem: (n: string) => unknown; refresh: () => void }).item = (
      i: number,
    ) => (plugins as unknown as unknown[])[i] || null;
    (plugins as unknown as { namedItem: (n: string) => unknown }).namedItem = (n: string) =>
      (plugins as unknown as { name: string }[]).find((x) => x.name === n) || null;
    (plugins as unknown as { refresh: () => void }).refresh = () => undefined;
    Object.defineProperty(navigator, "plugins", { get: () => plugins, configurable: true });
  } catch {
    /* ignore */
  }

  try {
    const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (originalQuery) {
      window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
        parameters?.name === "notifications"
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);
    }
  } catch {
    /* ignore */
  }

  try {
    // Chỉ relay ICE — không leak host/srflx khi có proxy (defense-in-depth với Chrome flags)
    const rtc = window.RTCPeerConnection;
    if (rtc && !(rtc as unknown as { __apmPatched?: boolean }).__apmPatched) {
      const Patched = function (
        this: RTCPeerConnection,
        config?: RTCConfiguration,
        ...rest: unknown[]
      ) {
        const cfg: RTCConfiguration = { ...(config || {}) };
        cfg.iceTransportPolicy = "relay";
        return new rtc(cfg, ...(rest as []));
      } as unknown as typeof RTCPeerConnection;
      Patched.prototype = rtc.prototype;
      (Patched as unknown as { __apmPatched: boolean }).__apmPatched = true;
      window.RTCPeerConnection = Patched;
    }
  } catch {
    /* ignore */
  }

  try {
    const patchGetParameter = (proto: { getParameter: (p: number) => unknown; __apmPatched?: boolean } | undefined) => {
      if (!proto || proto.__apmPatched) return;
      const getParameter = proto.getParameter;
      proto.getParameter = function (this: unknown, parameter: number) {
        if (parameter === 37445) return "Google Inc. (NVIDIA)";
        if (parameter === 37446) {
          return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)";
        }
        return getParameter.call(this, parameter);
      };
      proto.__apmPatched = true;
    };
    patchGetParameter(WebGLRenderingContext?.prototype as never);
    const wgl2 = (window as unknown as { WebGL2RenderingContext?: { prototype: unknown } }).WebGL2RenderingContext;
    patchGetParameter(wgl2?.prototype as never);
  } catch {
    /* ignore */
  }
}

async function injectIntoFrame(frame: Frame) {
  try {
    await frame.evaluate(stealthInPage);
  } catch {
    /* cross-origin / detached */
  }
}

export async function applyStealth(page: Page) {
  // Mọi document/iframe mới (CDP)
  const client = await page.createCDPSession();
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${stealthInPage.toString()})();`,
  });

  // Document hiện tại
  await page.evaluate(stealthInPage).catch(() => undefined);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    await injectIntoFrame(frame);
  }

  page.on("frameattached", (frame) => {
    void injectIntoFrame(frame);
  });

  await page.setExtraHTTPHeaders({
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  });
}
