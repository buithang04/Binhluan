import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async overview() {
    const [accounts, proxies, profiles, jobsToday, workersOnline, queue] =
      await Promise.all([
        this.prisma.googleAccount.count(),
        this.prisma.proxy.count(),
        this.prisma.profile.groupBy({ by: ["status"], _count: true }),
        this.prisma.jobRun.count({
          where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        }),
        this.prisma.workerNode.count({
          where: {
            status: "ONLINE",
            lastHeartbeat: { gte: new Date(Date.now() - 60_000) },
          },
        }),
        this.queue.stats(),
      ]);

    return {
      accounts,
      proxies,
      profilesByStatus: Object.fromEntries(
        profiles.map((p) => [p.status, p._count]),
      ),
      jobsLast24h: jobsToday,
      workersOnline,
      queue,
    };
  }
}
