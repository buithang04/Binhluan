import { Module } from "@nestjs/common";
import { WorkersModule } from "../workers/workers.module";
import { InternalController } from "./internal.controller";
import { InternalService } from "./internal.service";

@Module({
  imports: [WorkersModule],
  controllers: [InternalController],
  providers: [InternalService],
})
export class InternalModule {}
