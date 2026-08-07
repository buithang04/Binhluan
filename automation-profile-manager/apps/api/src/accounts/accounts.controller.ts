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

  /** Enqueue đổi hồ sơ Google (tên/avatar/địa chỉ) hàng loạt. */
  @Post("profile-update/bulk")
  @Roles("ADMIN")
  bulkProfileUpdate(@Body() body: unknown) {
    const parsed = (body ?? {}) as { accountIds?: string[] };
    return this.accounts.bulkEnqueueProfileUpdate(parsed.accountIds ?? []);
  }

  @Post(":id/profile-update")
  @Roles("ADMIN")
  profileUpdate(@Param("id") id: string) {
    return this.accounts.enqueueProfileUpdate(id);
  }

  /** Lưu tên / địa chỉ mong muốn hàng loạt (gán hồ sơ từ Excel). */
  @Post("desired-profile/bulk")
  @Roles("ADMIN")
  bulkDesiredProfile(@Body() body: unknown) {
    const parsed = (body ?? {}) as {
      items?: Array<{
        accountId?: string;
        desiredName?: string | null;
        desiredAddress?: string | null;
      }>;
    };
    return this.accounts.bulkSetDesiredProfile(parsed.items ?? []);
  }

  /** Upload trực tiếp một file avatar (base64 JSON, tối đa 8MB). */
  @Post(":id/avatar-upload")
  @Roles("ADMIN")
  uploadAvatar(@Param("id") id: string, @Body() body: unknown) {
    return this.accounts.uploadAvatar(
      id,
      body as { fileName?: string; dataBase64?: string },
    );
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

  /** Enqueue quét tên + avatar Google của 1 account. */
  @Post(":id/scan-profile")
  @Roles("ADMIN")
  scanProfile(@Param("id") id: string) {
    return this.accounts.enqueueScanGoogleProfile(id);
  }

  /** Enqueue quét tên + avatar Google hàng loạt. */
  @Post("scan-profile/bulk")
  @Roles("ADMIN")
  bulkScanProfile(@Body() body: unknown) {
    const parsed = (body ?? {}) as { accountIds?: string[] };
    return this.accounts.bulkEnqueueScanGoogleProfile(parsed.accountIds ?? []);
  }

  @Delete(":id")
  @Roles("ADMIN")
  remove(@Param("id") id: string) {
    return this.accounts.remove(id);
  }
}
