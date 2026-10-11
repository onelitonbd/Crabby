// The live tail behind `GET /events`. Deliberately in-process and tiny: the Gateway, the runtime and the storage
// write are one process (`ARCHITECTURE.md` §5), so a broker would be a queue between two halves of the same function
// call. What it must guarantee instead is §5.1's "a stream must never block a task": `publish` never awaits a writer,
// and a subscriber whose socket is behind gets a recorded gap, not backpressure.
import type { Event } from "@crabby/api-contracts";
import type { StreamEndReason } from "./sse.ts";

export interface Subscriber {
  readonly matches: (event: Event) => boolean;
  write(event: Event): void;
  fail(error: unknown): void;
  /** Called once when the stream ends, either because the client went away, because the Gateway is draining, or because
   *  the identity behind it was revoked — D-066's 5 s drain is only honest if a live SSE connection can be ended inside
   *  it, and `SECURITY.md` §3.1's revocation is only honest if the same is true of a revocation. The reason is what the
   *  subscriber writes in its last frame; omitting it means "nobody is watching, just stop". */
  close(reason?: StreamEndReason): void;
  /** The paired identity that opened this stream. Optional because the bus is not the party that resolves tokens — a
   *  subscriber with no identity simply cannot be reached by `closeFor`, which is why the event route binds one. */
  readonly clientId?: string | undefined;
}

export interface EventBus {
  subscribe(subscriber: Subscriber): () => void;
  publish(event: Event): void;
  /** End every live stream. Registration order, so a client sees `system.shutting-down` before its socket closes. */
  closeAll(reason?: StreamEndReason): void;
  /** End the live streams one identity owns, in registration order, and report how many ended. This is `SECURITY.md`
   *  §3.1's second half — "revocation takes effect on the next request *and must also terminate live event streams*" —
   *  and the reason it is keyed by client id rather than by token is that the token is what was deleted: an id is the
   *  only handle left. A count is returned rather than nothing because a route that cannot say how many streams it ended
   *  is a route whose operator has to guess whether the control did anything. */
  closeFor(clientId: string, reason?: StreamEndReason): number;
  readonly subscriberCount: number;
  /** How many live streams one identity holds. `subscriberCount` answers "is a Gateway being watched"; this answers the
   *  question `GET /auth/clients` and the TUI's confirmation prompt have to ask, which is *whose* — and both need it
   *  before the act, not after (`docs/review/TUI.md` T14-03: name the count, then end them). */
  countFor(clientId: string): number;
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
    closeAll(reason) {
      for (const subscriber of [...subscribers]) {
        subscribers.delete(subscriber);
        try {
          subscriber.close(reason);
        } catch {
          /* a socket that is already gone is the outcome we wanted */
        }
      }
    },
    closeFor(clientId, reason = "revoked") {
      let ended = 0;
      for (const subscriber of [...subscribers]) {
        if (subscriber.clientId !== clientId) continue;
        // Deleted before it is closed, so a `close` that writes and fails cannot re-enter `publish` through a
        // subscriber the bus has already let go of.
        subscribers.delete(subscriber);
        ended += 1;
        try {
          subscriber.close(reason);
        } catch {
          /* the identity is gone, which is the whole point; a socket that refuses a last frame changes nothing */
        }
      }
      return ended;
    },
    get subscriberCount() {
      return subscribers.size;
    },
    countFor(clientId) {
      let live = 0;
      for (const subscriber of subscribers) if (subscriber.clientId === clientId) live += 1;
      return live;
    },
    dropped(subscriber) {
      return dropped.get(subscriber) ?? 0;
    },
  };
}
