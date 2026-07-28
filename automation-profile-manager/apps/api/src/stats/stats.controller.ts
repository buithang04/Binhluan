import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard, Roles, RolesGuard } from "../auth/guards";
import { StatsService } from "./stats.service";

@Controller("stats")
@UseGuards(JwtAuthGuard, RolesGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get("overview")
  @Roles("ADMIN")
  overview() {    return this.stats.overview();
  }
}
