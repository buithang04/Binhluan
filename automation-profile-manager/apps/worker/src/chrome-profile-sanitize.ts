/**
 * Dọn Chrome trùng / zombie theo user-data-dir.
 * - Nhiều process MAIN cùng profile → giữ instance có DevTools OK, kill phần còn lại
 * - DevTools chết nhưng process còn → kill hết + xóa lock → sẵn sàng launch mới
 * - Không đụng profile đang MAPS/LOGIN với browser CDP còn nối
 */
import path from "node:path";

export type SanitizeDeps = {
  readDevToolsPort: (userDataDir: string) => Promise<number | null>;
  isDevToolsReachable: (port: number) => Promise<boolean>;
  clearStaleProfileLocks: (userDataDir: string) => Promise<void>;
};

export type SanitizeProfileInput = {
  userDataDir: string;
  profileId: string;
  browserIndex: number;
  reason: string;
  /** true = bỏ qua (đang MAPS/LOGIN với CDP sống) */
  isBusy: () => boolean;
  deps: SanitizeDeps;
};

export type SanitizeProfileResult = {
  action:
    | "skipped-busy"
    | "none"
    | "ok"
    | "deduped"
    | "killed-zombie"
    | "killed-all";
  readyToLaunch: boolean;
  devtoolsPort: number | null;
  keptPid?: number;
  killedPids: number[];
};

let pidMapCache: { at: number; map: Map<string, number[]> } | null = null;

export function invalidateChromeProfileCache() {
  pidMapCache = null;
}

/** Mọi PID Chrome MAIN (--user-data-dir, không --type=) theo thư mục profile. */
export async function listAllChromeMainPidsByUserDataDir(): Promise<
  Map<string, number[]>
> {
  const out = new Map<string, number[]>();
  if (process.platform !== "win32") return out;

  const now = Date.now();
  if (pidMapCache && now - pidMapCache.at < 3_000) {
    return pidMapCache.map;
  }

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const ps = `
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--user-data-dir' } |
  ForEach-Object {
    $cl = $_.CommandLine
    $dir = $null
    if ($cl -match '--user-data-dir=(?:"([^"]+)"|(\\S+))') {
      $dir = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    } elseif ($cl -match '--user-data-dir\\s+(?:"([^"]+)"|(\\S+))') {
      $dir = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    }
    if ($dir) {
      try { $dir = [System.IO.Path]::GetFullPath($dir) } catch {}
      Write-Output (($dir.ToLowerInvariant()) + '|' + $_.ProcessId)
    }
  }
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 25_000, windowsHide: true, encoding: "utf8" },
    );
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || !t.includes("|")) continue;
      const i = t.lastIndexOf("|");
      const dir = t.slice(0, i);
      const pid = Number(t.slice(i + 1));
      if (!dir || !Number.isFinite(pid) || pid <= 0) continue;
      const arr = out.get(dir) ?? [];
      if (!arr.includes(pid)) arr.push(pid);
      out.set(dir, arr);
    }
  } catch {
    /* ignore */
  }

  pidMapCache = { at: now, map: out };
  return out;
}

export async function resolveBestChromePidForProfileDir(
  userDataDir: string,
): Promise<number | undefined> {
  const key = path.resolve(userDataDir).toLowerCase();
  const pids = (await listAllChromeMainPidsByUserDataDir()).get(key);
  if (!pids?.length) return undefined;
  return pids[0];
}

/** Kill mọi chrome.exe có user-data-dir trùng (MAIN + child có path trong cmdline). */
export async function forceKillChromeForProfileDir(
  userDataDir: string,
): Promise<number[]> {
  invalidateChromeProfileCache();
  const abs = path.resolve(userDataDir);
  const killed: number[] = [];

  if (process.platform === "win32") {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const needleA = abs.replace(/'/g, "''");
    const needleB = abs.replace(/\\/g, "/").replace(/'/g, "''");
    const leaf = path.basename(abs).replace(/'/g, "''");
    const ps = `
$needles = @('${needleA}', '${needleB}', '${leaf}')
$killed = @()
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return }
  foreach ($n in $needles) {
    if ($cl.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $killed += $_.ProcessId
      } catch {}
      break
    }
  }
}
Start-Sleep -Milliseconds 1200
$lock = Join-Path '${needleA}' 'SingletonLock'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
$killed -join ','
`;
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { timeout: 25_000, windowsHide: true, encoding: "utf8" },
      );
      for (const part of String(stdout || "").split(",")) {
        const pid = Number(part.trim());
        if (Number.isFinite(pid) && pid > 0) killed.push(pid);
      }
    } catch {
      /* ignore */
    }
  } else {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("pkill", ["-f", userDataDir], { timeout: 8_000 }).catch(
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 800));
  }

  invalidateChromeProfileCache();
  return killed;
}

async function forceKillChromePids(pids: number[]): Promise<void> {
  if (!pids.length) return;
  invalidateChromeProfileCache();
  if (process.platform === "win32") {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const idList = pids.join(",");
    const ps = `
$ids = @(${idList}) | ForEach-Object { [int]$_ }
foreach ($id in $ids) {
  if ($id -gt 0) {
    try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}
  }
}
Start-Sleep -Milliseconds 800
`;
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 15_000, windowsHide: true },
    ).catch(() => undefined);
  } else {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        /* ignore */
      }
    }
  }
  invalidateChromeProfileCache();
}

/**
 * Dọn Chrome cho 1 profile automation.
 * Sau khi gọi: nếu readyToLaunch=true → connectOrLaunchBrowser có thể spawn mới an toàn.
 */
export async function sanitizeProfileChrome(
  input: SanitizeProfileInput,
): Promise<SanitizeProfileResult> {
  const userDataDir = path.resolve(input.userDataDir);
  const empty: SanitizeProfileResult = {
    action: "none",
    readyToLaunch: true,
    devtoolsPort: null,
    killedPids: [],
  };

  if (input.isBusy()) {
    return { ...empty, action: "skipped-busy", readyToLaunch: false };
  }

  const key = userDataDir.toLowerCase();
  const pids = (await listAllChromeMainPidsByUserDataDir()).get(key) ?? [];

  if (!pids.length) {
    await input.deps.clearStaleProfileLocks(userDataDir).catch(() => undefined);
    return empty;
  }

  const port = await input.deps.readDevToolsPort(userDataDir);
  const devtoolsOk = port ? await input.deps.isDevToolsReachable(port) : false;

  if (devtoolsOk && port) {
    if (pids.length <= 1) {
      return {
        action: "ok",
        readyToLaunch: false,
        devtoolsPort: port,
        keptPid: pids[0],
        killedPids: [],
      };
    }

    const extras = pids.slice(1);
    console.warn(
      `[chrome-sanitize] #${input.browserIndex} ${input.reason} — ${pids.length} Chrome/profile, giữ DevTools :${port}, kill pid=[${extras.join(",")}]`,
    );
    await forceKillChromePids(extras);
    await new Promise((r) => setTimeout(r, 400));
    return {
      action: "deduped",
      readyToLaunch: false,
      devtoolsPort: port,
      keptPid: pids[0],
      killedPids: extras,
    };
  }

  console.warn(
    `[chrome-sanitize] #${input.browserIndex} ${input.reason} — Chrome zombie (pids=${pids.join(",")}, devtools=${port ?? "n/a"}) → kill + launch mới`,
  );
  const killed = await forceKillChromeForProfileDir(userDataDir);
  await input.deps.clearStaleProfileLocks(userDataDir);
  await new Promise((r) => setTimeout(r, 600));
  return {
    action: pids.length > 1 ? "killed-all" : "killed-zombie",
    readyToLaunch: true,
    devtoolsPort: null,
    killedPids: killed.length ? killed : pids,
  };
}

export type PruneIdleInput = {
  profileDirs: Array<{
    profileId: string;
    browserIndex: number;
    userDataDir: string;
  }>;
  isBusy: (profileId: string) => boolean;
  deps: SanitizeDeps;
};

/** Dọn định kỳ mọi profile không busy — gọi từ heartbeat. */
export async function pruneIdleProfileChrome(
  input: PruneIdleInput,
): Promise<{ sanitized: number; deduped: number; zombies: number }> {
  let sanitized = 0;
  let deduped = 0;
  let zombies = 0;

  for (const row of input.profileDirs) {
    if (input.isBusy(row.profileId)) continue;
    const key = path.resolve(row.userDataDir).toLowerCase();
    const pids =
      (await listAllChromeMainPidsByUserDataDir()).get(key) ?? [];
    if (pids.length === 0) continue;

    const r = await sanitizeProfileChrome({
      userDataDir: row.userDataDir,
      profileId: row.profileId,
      browserIndex: row.browserIndex,
      reason: "idle-prune",
      isBusy: () => input.isBusy(row.profileId),
      deps: input.deps,
    });

    if (r.action === "skipped-busy" || r.action === "none" || r.action === "ok") {
      continue;
    }
    sanitized += 1;
    if (r.action === "deduped") deduped += 1;
    if (r.action === "killed-zombie" || r.action === "killed-all") zombies += 1;
  }

  if (sanitized > 0) {
    console.log(
      `[chrome-sanitize] idle-prune done sanitized=${sanitized} deduped=${deduped} zombies=${zombies}`,
    );
  }
  return { sanitized, deduped, zombies };
}
