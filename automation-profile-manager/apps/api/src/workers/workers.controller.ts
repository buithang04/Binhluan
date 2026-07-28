import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard, Roles, RolesGuard } from "../auth/guards";
import { WorkersService } from "./workers.service";

@Controller("workers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Get()
  @Roles("ADMIN")
  list() {    return this.workers.list();
  }
}
