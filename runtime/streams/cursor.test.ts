import { assertEquals, assertLess, assertThrows } from "@std/assert";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
  MAX_OPERATION_CURSOR_STREAMS,
} from "./cursor.ts";

Deno.test("operation replay cursor round-trips canonical operation lanes", () => {
  const cursor = encodeOperationReplayCursor({
    eventPosition: "90071992547409931234",
    operationEventPositions: {
      "operation-a": "100",
      "operation-b": "99",
    },
    operationStreamPositions: {
      "operation-a": { highWatermark: 1, offsets: { "2": 42 } },
    },
  });
  assertEquals(/^[A-Za-z0-9_-]+$/.test(cursor), true);
  assertEquals(decodeOperationReplayCursor(cursor), {
    eventPosition: "90071992547409931234",
    operationEventPositions: {
      "operation-a": "100",
      "operation-b": "99",
    },
    operationStreamPositions: {
      "operation-a": { highWatermark: 1, offsets: { "2": 42 } },
    },
  });
  assertEquals(decodeOperationReplayCursor(undefined), {});
});

Deno.test("operation replay cursor rejects malformed and unbounded positions", () => {
  assertThrows(() => decodeOperationReplayCursor("not+base64"), TypeError);
  assertThrows(() =>
    encodeOperationReplayCursor({
      eventPosition: "-1",
    }), TypeError);
  assertThrows(() =>
    encodeOperationReplayCursor({
      operationStreamPositions: {
        operation: {
          highWatermark: 0,
          offsets: Object.fromEntries(
            Array.from(
              { length: MAX_OPERATION_CURSOR_STREAMS + 1 },
              (_, index) => [String(index + 1), index],
            ),
          ),
        },
      },
    }), TypeError);
});

Deno.test("operation replay cursor stays header-safe for 150 compact lanes", () => {
  const cursor = encodeOperationReplayCursor({
    eventPosition: "123456789",
    operationStreamPositions: {
      operation: {
        highWatermark: 0,
        offsets: Object.fromEntries(
          Array.from(
            { length: 150 },
            (_, index) => [String(index + 1), 10_000_000 + index],
          ),
        ),
      },
    },
  });

  // This leaves ample room for cookies and the rest of the request headers on
  // common managed HTTP frontends while representing a complex active run.
  assertLess(cursor.length, 4 * 1024);
  assertEquals(
    Object.keys(
      decodeOperationReplayCursor(cursor).operationStreamPositions?.operation
        .offsets ?? {},
    ).length,
    150,
  );
});

Deno.test("operation stream high-watermarks retain and then close sparse gaps", () => {
  const tracker = createOperationReplayCursorTracker({});
  tracker.commit([{
    kind: "operation-stream",
    action: "register",
    operationId: "operation-a",
    streamOrdinal: "1",
    offset: 0,
  }, {
    kind: "operation-stream",
    action: "register",
    operationId: "operation-a",
    streamOrdinal: "2",
    offset: 0,
  }, {
    kind: "operation-stream",
    action: "end",
    operationId: "operation-a",
    streamOrdinal: "2",
    offset: 11,
  }]);
  const interrupted = decodeOperationReplayCursor(tracker.cursor());
  assertEquals(interrupted.operationStreamPositions?.["operation-a"], {
    highWatermark: 2,
    offsets: { "1": 0 },
  });

  const resumed = createOperationReplayCursorTracker(interrupted);
  assertEquals(
    resumed.streamPosition({
      operationId: "operation-a",
      streamOrdinal: "2",
    }).consumed,
    true,
  );
  resumed.commit([{
    kind: "operation-stream",
    action: "end",
    operationId: "operation-a",
    streamOrdinal: "1",
    offset: 7,
  }]);
  assertEquals(
    decodeOperationReplayCursor(resumed.cursor()).operationStreamPositions?.[
      "operation-a"
    ],
    { highWatermark: 2, offsets: {} },
  );
});

Deno.test("operation stream high-watermark stays bounded past 256 sequential lanes", () => {
  const tracker = createOperationReplayCursorTracker({});
  for (let ordinal = 1; ordinal <= 1_024; ordinal++) {
    tracker.commit([{
      kind: "operation-stream",
      action: "register",
      operationId: "operation-deep",
      streamOrdinal: String(ordinal),
      offset: 0,
    }, {
      kind: "operation-stream",
      action: "end",
      operationId: "operation-deep",
      streamOrdinal: String(ordinal),
      offset: ordinal,
    }]);
  }
  const cursor = tracker.cursor();
  assertLess(cursor.length, 256);
  assertEquals(
    decodeOperationReplayCursor(cursor).operationStreamPositions?.[
      "operation-deep"
    ],
    { highWatermark: 1_024, offsets: {} },
  );
});

Deno.test("operation replay cursor reports concurrent lane capacity as a typed conflict", () => {
  const tracker = createOperationReplayCursorTracker({});
  for (let ordinal = 1; ordinal <= MAX_OPERATION_CURSOR_STREAMS; ordinal++) {
    tracker.commit([{
      kind: "operation-stream",
      action: "register",
      operationId: "operation-wide",
      streamOrdinal: String(ordinal),
      offset: 0,
    }]);
  }
  const error = assertThrows(() =>
    tracker.cursor([{
      kind: "operation-stream",
      action: "register",
      operationId: "operation-wide",
      streamOrdinal: String(MAX_OPERATION_CURSOR_STREAMS + 1),
      offset: 0,
    }])
  );
  assertEquals((error as { status?: unknown }).status, 409);
  assertEquals(
    (error as { code?: unknown }).code,
    "operation_replay_capacity_exceeded",
  );
});

Deno.test("selection registration is atomic and terminal retirement bounds sequential operations", () => {
  const tracker = createOperationReplayCursorTracker({});
  tracker.commit([{
    kind: "selection",
    position: "2",
    operationIds: ["first", "second"],
  }]);
  assertEquals(
    decodeOperationReplayCursor(tracker.cursor()).operationSelectionPositions,
    { first: "2", second: "2" },
  );
  tracker.commit([{ kind: "retire", operationId: "first" }, {
    kind: "retire",
    operationId: "second",
  }]);
  for (let index = 3; index <= 1_000; index++) {
    const operationId = `op-${index}`;
    tracker.commit([
      {
        kind: "selection",
        position: String(index),
        operationIds: [operationId],
      },
      { kind: "event", operationId, position: "9" },
      {
        kind: "operation-stream",
        action: "register",
        operationId,
        streamOrdinal: "1",
        offset: 0,
      },
    ]);
    assertThrows(
      () => tracker.cursor([{ kind: "retire", operationId }]),
      TypeError,
      "unfinished lanes",
    );
    tracker.commit([{
      kind: "operation-stream",
      action: "end",
      operationId,
      streamOrdinal: "1",
      offset: 9,
    }, { kind: "retire", operationId }]);
    assertLess(tracker.cursor().length, 100);
  }
  assertEquals(decodeOperationReplayCursor(tracker.cursor()), {
    selectionPosition: "1000",
  });
});

Deno.test("32 late terminal tombstones free selection slots before unseen history advances", () => {
  const tracker = createOperationReplayCursorTracker({});
  const operations = Array.from({ length: 32 }, (_, index) => `late-${index}`);
  tracker.commit([{
    kind: "selection",
    position: "32",
    operationIds: operations,
  }]);
  for (const [index, operationId] of operations.entries()) {
    tracker.commit([{ kind: "event", operationId, position: "3" }, {
      kind: "retire",
      operationId,
      position: String(1001 + index),
    }]);
  }
  const detached = decodeOperationReplayCursor(tracker.cursor());
  assertEquals(detached.operationSelectionPositions, undefined);
  assertEquals(detached.operationEventPositions, undefined);
  assertEquals(
    Object.keys(detached.operationRetirementPositions ?? {}).length,
    32,
  );
  const resumed = createOperationReplayCursorTracker(detached);
  for (let ordinal = 33; ordinal <= 1000; ordinal++) {
    const operationId = `history-${ordinal}`;
    resumed.commit([{
      kind: "selection",
      position: String(ordinal),
      operationIds: [operationId],
    }, { kind: "retire", operationId, position: String(ordinal) }]);
    assertLess(resumed.cursor().length, 1100);
  }
  resumed.commit([{ kind: "selection", position: "1032", operationIds: [] }]);
  assertEquals(decodeOperationReplayCursor(resumed.cursor()), {
    selectionPosition: "1032",
  });
});

Deno.test("late terminal tombstones have a fixed capacity and a new revision can enroll again", () => {
  const operations = Array.from({ length: 33 }, (_, index) => `late-${index}`);
  const tracker = createOperationReplayCursorTracker({});
  tracker.commit([{
    kind: "selection",
    position: "33",
    operationIds: operations,
  }]);
  for (const operationId of operations.slice(0, 32)) {
    tracker.commit([{ kind: "retire", operationId, position: "100" }]);
  }
  const error = assertThrows(() =>
    tracker.cursor([{
      kind: "retire",
      operationId: operations[32],
      position: "101",
    }])
  );
  assertEquals(
    (error as { code: string }).code,
    "observation_renewal_required",
  );
  assertEquals(
    Object.keys(
      decodeOperationReplayCursor(tracker.cursor())
        .operationRetirementPositions ?? {},
    ).length,
    32,
  );
  tracker.commit([{
    kind: "selection",
    position: "102",
    operationIds: [operations[0]],
  }]);
  assertEquals(
    decodeOperationReplayCursor(tracker.cursor()).operationSelectionPositions,
    { [operations[32]]: "33", [operations[0]]: "102" },
  );
  assertEquals(
    decodeOperationReplayCursor(tracker.cursor()).operationRetirementPositions,
    undefined,
  );
});

Deno.test("the global-event cursor generation is rejected before operation-local replay", () => {
  const legacy = btoa(JSON.stringify({ kind: "operation-lanes", event: "42" }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const error = assertThrows(
    () => decodeOperationReplayCursor(legacy),
    TypeError,
  );
  assertEquals((error as { code?: string }).code, "invalid_replay_cursor");
});
