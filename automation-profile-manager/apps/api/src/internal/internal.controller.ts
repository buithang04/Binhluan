import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { WorkersService } from "../workers/workers.service";
import { InternalTokenGuard } from "./internal.guard";
import { InternalService } from "./internal.service";

@Controller("internal")
@UseGuards(InternalTokenGuard)
export class InternalController {
  constructor(
    private readonly internal: InternalService,
    private readonly workers: WorkersService,
  ) {}

  @Post("jobs/claim")
  claim(@Body() body: {
    profileId: string;
    leaseToken: string;
    jobRunId: string;
    workerId: string;
  }) {
    return this.internal.claim(body);
  }

  @Post("jobs/reswap-proxy")
  reswapProxy(@Body() body: {
    profileId: string;
    leaseToken: string;
    jobRunId: string;
    failedProxyId?: string;
  }) {
    return this.internal.reswapJobProxy(body);
  }

  @Post("jobs/fail")
  fail(@Body() body: {
    profileId: string;
    leaseToken: string;
    jobRunId: string;
    error: string;
    stacktrace?: string;
    disableProfile?: boolean;
    browserAlive?: boolean;
    workerId?: string;
  }) {
    return this.internal.fail(body);
  }

  @Post("browsers/event")
  browserEvent(@Body() body: {
    profileId: string;
    workerId: string;
    event: "opened" | "closed" | "ready";
    browserVersion?: string;
  }) {
    return this.internal.browserEvent(body);
  }

  @Post("browsers/login-issue")
  loginIssue(
    @Body()
    body: {
      profileId: string;
      workerId: string;
      issue: string | null;
    },
  ) {
    return this.internal.setLoginIssue(body);
  }

  @Post("browsers/reset-alive")
  resetAlive(@Body() body: { workerId?: string; all?: boolean; keepProfileIds?: string[] }) {
    return this.internal.resetBrowserAlive(
      body?.workerId,
      body?.all === true,
      body?.keepProfileIds,
    );
  }

  @Post("browsers/list-for-reclaim")
  listForReclaim() {
    return this.internal.listProfilesForReclaim();
  }

  @Post("jobs/complete")
  complete(@Body() body: {
    profileId: string;
    leaseToken: string;
    jobRunId: string;
    browserVersion?: string;
    result?: Record<string, unknown>;
    browserAlive?: boolean;
    workerId?: string;
    markReady?: boolean;
    loginIssue?: string | null;
  }) {
    return this.internal.complete(body);
  }

  /** Worker poll: lease bị clear / job FAILED → abort vòng chờ captcha. */
  @Post("jobs/abort-check")
  abortCheck(
    @Body() body: { profileId: string; leaseToken: string; jobRunId: string },
  ) {
    return this.internal.abortCheck(body);
  }

  @Post("workers/heartbeat")
  async heartbeat(@Body() body: {
    id: string;
    hostname: string;
    concurrency: number;
    runningJobs: number;
    cpuPercent?: number;
    memPercent?: number;
    queueLength?: number;
    status?: "ONLINE" | "DRAINING" | "OFFLINE";
    aliveProfileIds?: string[];
  }) {
    const node = await this.workers.heartbeat(body);
    if (Array.isArray(body.aliveProfileIds)) {
      await this.internal.syncAliveBrowsers(body.id, body.aliveProfileIds);
    }
    return node;
  }
}
