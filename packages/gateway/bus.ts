// The live tail behind `GET /events`. Deliberately in-process and tiny: the Gateway, the runtime and the storage
// write are one process (`ARCHITECTURE.md` §5), so a broker would be a queue between two halves of the same function
// call. What it must guarantee instead is §5.1's "a stream must never block a task": `publish` never awaits a writer,
// and a subscriber whose socket is behind gets a recorded gap, not backpressure.
import type { Event } from "@crabby/api-contracts";

export interface Subscriber {
  readonly matches: (event: Event) => boolean;
  write(event: Event): void;
  fail(error: unknown): void;
  /** Called once when the stream ends, either because the client went away or because the Gateway is draining.
   *  D-066's 5 s drain is only honest if a live SSE connection can be ended inside it. */
  close(): void;
}

export interface EventBus {
  subscribe(subscriber: Subscriber): () => void;
  publish(event: Event): void;
  /** End every live stream. Registration order, so a client sees `system.shutting-down` before its socket closes. */
  closeAll(): void;
  readonly subscriberCount: number;
  /** Dropped writes are counted per subscriber so a client can be told, in its own stream, that it fell behind. */
  dropped(subscriber: Subscriber): number;
}

export function createEventBus(): EventBus {
  const subscribers = new Set<Subscriber>();
  const dropped = new WeakMap<Subscriber, number>();
  return {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    publish(event) {
      for (const subscriber of subscribers) {
        if (!subscriber.matches(event)) continue;
        try {
          subscriber.write(event);
        } catch (error) {
          dropped.set(subscriber, (dropped.get(subscriber) ?? 0) + 1);
          subscriber.fail(error);
        }
      }
    },
    closeAll() {
      for (const subscriber of [...subscribers]) {
        subscribers.delete(subscriber);
        try {
          subscriber.close();
        } catch {
          /* a socket that is already gone is the outcome we wanted */
        }
      }
    },
    get subscriberCount() {
      return subscribers.size;
    },
    dropped(subscriber) {
      return dropped.get(subscriber) ?? 0;
    },
  };
}
