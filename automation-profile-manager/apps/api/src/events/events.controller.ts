import { Controller, Get, Query, Sse, UseGuards, MessageEvent } from "@nestjs/common";
import { Observable, interval, map } from "rxjs";
import { JwtAuthGuard, Roles, RolesGuard } from "../auth/guards";
import { LiveEventsService } from "./live-events.service";

@Controller("events")
@UseGuards(JwtAuthGuard, RolesGuard)
export class EventsController {
  constructor(private readonly live: LiveEventsService) {}

  @Get("live")
  @Roles("ADMIN")
  liveEvents(@Query("afterId") afterId?: string) {
    const id = Number(afterId || 0) || 0;
    const events = this.live.since(id);
    return {
      events,
      latestId: events.length ? events[events.length - 1]!.id : id,
    };
  }

  @Sse("stream")
  @Roles("ADMIN")
  stream(@Query("afterId") afterId?: string): Observable<MessageEvent> {
    let cursor = Number(afterId || 0) || 0;
    return interval(1500).pipe(
      map(() => {
        const batch = this.live.since(cursor);
        if (batch.length) cursor = batch[batch.length - 1]!.id;
        return { data: { events: batch } } as MessageEvent;
      }),
    );
  }
}
