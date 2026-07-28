import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  list(limit = 50) {
    return this.prisma.jobRun.findMany({
      take: Math.min(limit, 200),
      orderBy: { createdAt: "desc" },
      include: {
        profile: {
          select: {
            id: true,
            account: { select: { email: true } },
          },
        },
      },
    });
  }

  async get(id: string) {
    const row = await this.prisma.jobRun.findUnique({
      where: { id },
      include: {
        profile: {
          include: { account: { select: { email: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException("Job not found");
    return row;
  }

  queueStats() {
    return this.queue.stats();
  }
}
