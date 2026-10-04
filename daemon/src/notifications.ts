import { EventEmitter } from "node:events";
import type { WsEvent } from "./types.js";

export class NotificationBus extends EventEmitter {
  emitEvent(event: WsEvent): void {
    this.emit("event", event);
  }

  notify(title: string, body: string, agentId?: string): void {
    this.emitEvent({ type: "notification", title, body, agentId });
  }
}
