import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard, Roles, RolesGuard } from "../auth/guards";
import { JobsService } from "./jobs.service";

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get("jobs")
  @Roles("ADMIN")
  list(@Query("limit") limit?: string) {
    return this.jobs.list(limit ? Number(limit) : 50);
  }

  @Get("jobs/:id")
  @Roles("ADMIN")
  get(@Param("id") id: string) {
    return this.jobs.get(id);
  }

  @Get("queues/stats")
  @Roles("ADMIN")
  queueStats() {    return this.jobs.queueStats();
  }
}
