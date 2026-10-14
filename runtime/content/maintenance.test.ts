import { assertEquals } from "@std/assert";

import { createMemoryBodyStore } from "./body-store.ts";
import type {
  ActiveMutableBodyHead,
  BodyMaintenanceDeleteInput,
  BodyStore,
} from "./body-store.ts";
import { maintainProgressiveBodies } from "./maintenance.ts";

Deno.test("progressive body maintenance fences and terminates expired writers without semantic lookup", async () => {
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const writer = await store.reserve({
    bodyId: "content-streams/tenant-a/stream-a",
    mediaType: "text/plain",
  });
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "first",
    bytes: new TextEncoder().encode("partial"),
  });

  const result = await maintainProgressiveBodies(store);

  assertEquals(result, {
    examined: 1,
    aborted: 0,
    sealed: 0,
    terminated: 1,
    deferred: 0,
    errors: [],
  });
  assertEquals(
    (await store.head({ bodyId: writer.bodyId }))?.state,
    "incomplete",
  );
});

Deno.test("progressive maintenance continuation prevents live first-page starvation", async () => {
  const store = createMemoryBodyStore({ protectionMs: 100 });
  const expired = await store.reserve({
    bodyId: "z-expired",
    mediaType: "text/plain",
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await store.reserve({ bodyId: "a-live", mediaType: "text/plain" });
  await store.reserve({ bodyId: "b-live", mediaType: "text/plain" });

  const first = await maintainProgressiveBodies(store, { limit: 2 });
  assertEquals(first, {
    examined: 2,
    aborted: 0,
    sealed: 0,
    terminated: 0,
    deferred: 2,
    errors: [],
    after: "b-live",
  });
  const second = await maintainProgressiveBodies(store, {
    limit: 2,
    after: first.after,
  });
  assertEquals(second, {
    examined: 1,
    aborted: 0,
    sealed: 0,
    terminated: 1,
    deferred: 0,
    errors: [],
  });
  assertEquals(
    (await store.head({ bodyId: expired.bodyId }))?.state,
    "incomplete",
  );
});

Deno.test("progressive maintenance resumes expired sealing instead of aborting it", async () => {
  const base = createMemoryBodyStore({ protectionMs: 0 });
  const writer = await base.reserve({
    bodyId: "content-streams/tenant-a/sealing",
    mediaType: "text/plain",
  });
  const bytes = new TextEncoder().encode("frozen");
  await base.append({
    writer,
    expectedOffset: 0,
    appendId: "frozen",
    bytes,
  });
  const open = await base.head({ bodyId: writer.bodyId });
  if (!open || open.state !== "open") {
    throw new Error("Expected active progressive body.");
  }
  const sealing: ActiveMutableBodyHead = Object.freeze({
    ...open,
    state: "sealing",
    writerLeaseRemainingMs: 0,
  });
  let aborted = false;
  let sealedExpectedByteLength: number | undefined;
  const store: BodyStore = Object.freeze({
    ...base,
    abort(input) {
      aborted = true;
      return base.abort(input);
    },
    seal(input) {
      sealedExpectedByteLength = input.expectedByteLength;
      return base.seal(input);
    },
    maintenance: Object.freeze({
      ...base.maintenance,
      list: () =>
        Promise.resolve(Object.freeze({ bodies: Object.freeze([sealing]) })),
    }),
  });

  assertEquals(await maintainProgressiveBodies(store), {
    examined: 1,
    aborted: 0,
    sealed: 1,
    terminated: 0,
    deferred: 0,
    errors: [],
  });
  assertEquals(aborted, false);
  assertEquals(sealedExpectedByteLength, bytes.byteLength);
  assertEquals((await base.head({ bodyId: writer.bodyId }))?.state, "ready");
});

Deno.test("progressive maintenance resumes expired terminating bodies as incomplete", async () => {
  const base = createMemoryBodyStore({ protectionMs: 0 });
  const writer = await base.reserve({
    bodyId: "content-streams/tenant-a/terminating",
    mediaType: "text/plain",
  });
  const bytes = new TextEncoder().encode("retained");
  await base.append({
    writer,
    expectedOffset: 0,
    appendId: "retained",
    bytes,
  });
  const open = await base.head({ bodyId: writer.bodyId });
  if (!open || open.state !== "open") {
    throw new Error("Expected active progressive body.");
  }
  const terminating: ActiveMutableBodyHead = Object.freeze({
    ...open,
    state: "terminating",
    writerLeaseRemainingMs: 0,
  });
  const store: BodyStore = Object.freeze({
    ...base,
    maintenance: Object.freeze({
      ...base.maintenance,
      list: () =>
        Promise.resolve(Object.freeze({
          bodies: Object.freeze([terminating]),
        })),
    }),
  });

  assertEquals(await maintainProgressiveBodies(store), {
    examined: 1,
    aborted: 0,
    sealed: 0,
    terminated: 1,
    deferred: 0,
    errors: [],
  });
  assertEquals(
    (await base.head({ bodyId: writer.bodyId }))?.state,
    "incomplete",
  );
});

Deno.test("progressive maintenance retries fenced abort cleanup", async () => {
  const base = createMemoryBodyStore({ protectionMs: 0 });
  let deleted = 0;
  const store: BodyStore = Object.freeze({
    ...base,
    reserve() {
      throw new Error("aborted cleanup must not reserve a writer");
    },
    maintenance: Object.freeze({
      list: () =>
        Promise.resolve(Object.freeze({
          bodies: Object.freeze([Object.freeze({
            bodyId: "content-streams/tenant-a/aborting",
            state: "aborted" as const,
            mediaType: "text/plain",
            byteLength: 7,
            discarded: 0,
            maintenanceVersion: 4,
            reservationId: "fenced-abort",
          })]),
        })),
      delete(input: BodyMaintenanceDeleteInput) {
        assertEquals(input, {
          bodyId: "content-streams/tenant-a/aborting",
          expectedState: "aborted",
          expectedMaintenanceVersion: 4,
          idleForMs: 0,
        });
        deleted++;
        return Promise.resolve(true);
      },
    }),
  });

  assertEquals(await maintainProgressiveBodies(store), {
    examined: 1,
    aborted: 1,
    sealed: 0,
    terminated: 0,
    deferred: 0,
    errors: [],
  });
  assertEquals(deleted, 1);
});
