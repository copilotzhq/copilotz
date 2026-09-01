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
