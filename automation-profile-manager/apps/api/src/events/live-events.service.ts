import { Injectable } from "@nestjs/common";

export type LiveEvent = {
  id: number;
  at: string;
  type: "browser.opened" | "browser.ready" | "browser.closed" | "info";
  message: string;
  profileId?: string;
  browserIndex?: number;
  email?: string;
  status?: string;
};

@Injectable()
export class LiveEventsService {
  private seq = 0;
  private readonly ring: LiveEvent[] = [];
  private readonly max = 200;

  push(partial: Omit<LiveEvent, "id" | "at"> & { at?: string }) {
    const event: LiveEvent = {
      id: ++this.seq,
      at: partial.at || new Date().toISOString(),
      type: partial.type,
      message: partial.message,
      profileId: partial.profileId,
      browserIndex: partial.browserIndex,
      email: partial.email,
      status: partial.status,
    };
    this.ring.push(event);
    if (this.ring.length > this.max) this.ring.shift();
    return event;
  }

  since(afterId = 0) {
    return this.ring.filter((e) => e.id > afterId);
  }

  latest(limit = 30) {
    return this.ring.slice(-limit);
  }
}
