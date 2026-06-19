import type { ForgeEvent } from './types';

type EventHandler<T = unknown> = (event: ForgeEvent<T>) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, EventHandler[]>();

  subscribe(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async publish(event: ForgeEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];

    for (const handler of handlers) {
      await handler(event);
    }
  }
}

export const eventBus = new EventBus();
