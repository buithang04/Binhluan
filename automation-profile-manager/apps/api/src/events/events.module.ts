import { Global, Module } from "@nestjs/common";
import { EventsController } from "./events.controller";
import { LiveEventsService } from "./live-events.service";

@Global()
@Module({
  controllers: [EventsController],
  providers: [LiveEventsService],
  exports: [LiveEventsService],
})
export class EventsModule {}
