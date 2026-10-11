// The bus, tested as the one object that decides which live stream a revocation is allowed to end. `bus.ts` is small on
// purpose — §5.1's rule is that a stream must never block a task, so there is no queue and no retry here — and that
// restraint is why the two guarantees that *are* here deserve their own file: `publish` never awaits a writer, and
// `closeFor` ends exactly the identity it was told to end, in registration order, with the frame that tells the client
// not to come back (`SECURITY.md` §3.1's second half, D-096).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event } from "@crabby/api-contracts";
import { createEventBus, type Subscriber } from "./bus.ts";
import type { StreamEndReason } from "./sse.ts";

function event(type: string, taskId = "tsk_a"): Event {
  return {
    id: `evt_${type}_${taskId}`,
    schemaVersion: 1,
    type,
    ts: new Date(0).toISOString(),
    sessionId: "ses_a",
    taskId,
    seq: 1,
    payload: { type },
  } as Event;
}

/** A subscriber that remembers what the bus did to it. Every assertion in this file is about one of those three lists. */
function recorder(clientId?: string) {
  const written: Event[] = [];
  const closed: (StreamEndReason | undefined)[] = [];
  const failures: unknown[] = [];
  const subscriber: Subscriber = {
    matches: () => true,
    write: (event) => {
      written.push(event);
    },
    fail: (error) => {
      failures.push(error);
    },
    close: (reason) => {
      closed.push(reason);
    },
    ...(clientId === undefined ? {} : { clientId }),
  };
  return { subscriber, written, closed, failures };
}

/** The version of `write` a real slow socket has: it throws. A bus that let that reach the publisher would be §5.1's
 *  named defect, so this fixture is what proves the count exists *instead of* the exception escaping. */
function failingRecorder(clientId?: string) {
  const failures: unknown[] = [];
  const subscriber: Subscriber = {
    matches: () => true,
    write() {
      throw new Error("backpressure");
    },
    fail: (error) => {
      failures.push(error);
    },
    close: () => {},
    ...(clientId === undefined ? {} : { clientId }),
  };
  return { subscriber, failures };
}

describe("the event bus (a live tail that cannot block a task)", () => {
  it("ends only the streams the revoked identity opened, and says how many", () => {
    const bus = createEventBus();
    const phone = recorder("cln_phone");
    const laptop = recorder("cln_laptop");
    const unbound = recorder();
    bus.subscribe(phone.subscriber);
    bus.subscribe(laptop.subscriber);
    bus.subscribe(unbound.subscriber);

    const ended = bus.closeFor("cln_phone");

    assert.equal(ended, 1, "one stream belonged to the identity that was revoked");
    assert.deepEqual(
      phone.closed,
      ["revoked"],
      "with the reason, because a close that says nothing is what a client reconnects through",
    );
    assert.deepEqual(
      laptop.closed,
      [],
      "the other identity keeps its stream — revocation affects that client only",
    );
    assert.deepEqual(unbound.closed, [], "and a subscriber with no identity is nobody's to close");
    assert.equal(
      bus.subscriberCount,
      2,
      "the closed subscriber is gone from the bus, not merely idle",
    );
    assert.equal(
      bus.closeFor("cln_phone"),
      0,
      "and a second revocation of the same id ends nothing twice",
    );
  });

  it("counts live streams per identity, which is what a confirmation prompt reads", () => {
    const bus = createEventBus();
    const phone = recorder("cln_phone");
    const second = recorder("cln_phone");
    const laptop = recorder("cln_laptop");
    bus.subscribe(phone.subscriber);
    bus.subscribe(second.subscriber);
    bus.subscribe(laptop.subscriber);
    bus.subscribe(recorder().subscriber);

    assert.equal(
      bus.countFor("cln_phone"),
      2,
      "two tabs of the same app are two streams — `SECURITY.md` §3.1's revocation ends both, and the TUI's prompt " +
        "(T14-03) has to name the number before it acts",
    );
    assert.equal(bus.countFor("cln_laptop"), 1);
    assert.equal(
      bus.countFor("cln_nobody"),
      0,
      "an identity with no stream is not an error, it is idle",
    );
    assert.equal(
      bus.subscriberCount,
      4,
      "and the process-wide count still includes the unbound subscriber, because the two numbers answer " +
        "different questions and collapsing them would lose one",
    );
  });

  it("keeps publishing to the survivors, and never to the identity it closed", () => {
    const bus = createEventBus();
    const phone = recorder("cln_phone");
    const laptop = recorder("cln_laptop");
    bus.subscribe(phone.subscriber);
    bus.subscribe(laptop.subscriber);
    bus.closeFor("cln_phone");

    bus.publish(event("task.progress"));

    assert.equal(laptop.written.length, 1);
    assert.equal(
      phone.written.length,
      0,
      "a revoked identity receives nothing after the revocation — not even a late frame it could still act on",
    );
  });

  it("survives a subscriber whose socket is already gone", () => {
    const bus = createEventBus();
    const broken: Subscriber = {
      clientId: "cln_gone",
      matches: () => true,
      write: () => {},
      fail: () => {},
      close() {
        throw new Error("the socket went while we were saying goodbye");
      },
    };
    const other = recorder("cln_other");
    bus.subscribe(broken);
    bus.subscribe(other.subscriber);

    assert.equal(
      bus.closeFor("cln_gone"),
      1,
      "a stream that cannot be closed politely is still closed: the identity is gone, which is the outcome, and a throw " +
        "from a dead socket must not turn a revocation into a 500 in the route that performed it",
    );
    bus.closeAll("shutdown");
    assert.deepEqual(
      other.closed,
      ["shutdown"],
      "and the drain reaches what is left with its own reason",
    );
  });

  it("counts a dropped write per subscriber, which is what makes a gap the client's own", () => {
    const bus = createEventBus();
    const slow = failingRecorder("cln_slow");
    bus.subscribe(slow.subscriber);

    bus.publish(event("task.progress"));
    bus.publish(event("task.completed"));

    assert.equal(
      bus.dropped(slow.subscriber),
      2,
      "§5.1: slow delivery is recorded as a gap rather than turned into backpressure on the task — and the count is per " +
        "subscriber, because a client that fell behind is one client's problem",
    );
    assert.equal(
      slow.failures.length,
      2,
      "and the subscriber was told each time, so it can end itself instead of trailing the task forever",
    );
  });

  it("unsubscribes through the returned handle without closing, which is how a client leaving looks", () => {
    const bus = createEventBus();
    const one = recorder("cln_one");
    const unsubscribe = bus.subscribe(one.subscriber);

    unsubscribe();
    bus.closeFor("cln_one");

    assert.equal(bus.subscriberCount, 0);
    assert.deepEqual(
      one.closed,
      [],
      "the client hung up, so nobody owes it an `end` frame — the frame is for a close the Gateway chose",
    );
  });
});
