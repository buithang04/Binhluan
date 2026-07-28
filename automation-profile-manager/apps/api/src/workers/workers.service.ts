import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WorkersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.workerNode.findMany({ orderBy: { lastHeartbeat: "desc" } });
  }

  async heartbeat(input: {
    id: string;
    hostname: string;
    concurrency: number;
    runningJobs: number;
    cpuPercent?: number;
    memPercent?: number;
    queueLength?: number;
    status?: "ONLINE" | "DRAINING" | "OFFLINE";
  }) {
    return this.prisma.workerNode.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        hostname: input.hostname,
        concurrency: input.concurrency,
        runningJobs: input.runningJobs,
        cpuPercent: input.cpuPercent,
        memPercent: input.memPercent,
        queueLength: input.queueLength ?? 0,
        status: input.status ?? "ONLINE",
        lastHeartbeat: new Date(),
      },
      update: {
        hostname: input.hostname,
        concurrency: input.concurrency,
        runningJobs: input.runningJobs,
        cpuPercent: input.cpuPercent,
        memPercent: input.memPercent,
        queueLength: input.queueLength ?? 0,
        status: input.status ?? "ONLINE",
        lastHeartbeat: new Date(),
      },
    });
  }
}
