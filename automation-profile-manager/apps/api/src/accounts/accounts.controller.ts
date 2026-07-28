import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard, Roles, RolesGuard } from "../auth/guards";
import { AccountsService } from "./accounts.service";

@Controller("accounts")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @Roles("ADMIN")
  list() {
    return this.accounts.list();
  }

  @Get(":id")
  @Roles("ADMIN")
  get(@Param("id") id: string) {
    return this.accounts.get(id);
  }

  @Post()
  @Roles("ADMIN")
  create(@Body() body: unknown) {
    return this.accounts.create(body as never);
  }

  /** Import hàng loạt từ Excel (client parse → JSON). */
  @Post("import")
  @Roles("ADMIN")
  importMany(@Body() body: unknown) {
    return this.accounts.importMany(body as never);
  }

  @Put(":id")
  @Roles("ADMIN")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.accounts.update(id, body as never);
  }

  /** Làm mới Chrome profile (xóa session cũ — dùng khi loop login / đổi email tay). */
  @Post(":id/reset-browser")
  @Roles("ADMIN")
  resetBrowser(@Param("id") id: string) {
    return this.accounts.resetBrowserProfile(id);
  }

  @Delete(":id")
  @Roles("ADMIN")
  remove(@Param("id") id: string) {
    return this.accounts.remove(id);
  }
}
