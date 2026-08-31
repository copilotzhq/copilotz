import { assertEquals, assertLess, assertThrows } from "@std/assert";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
  MAX_OPERATION_CURSOR_STREAMS,
  operationStreamReplayCursorKey,
} from "./cursor.ts";

Deno.test("operation replay cursor round-trips opaque event and stream positions", () => {
  const cursor = encodeOperationReplayCursor({
    eventPosition: "90071992547409931234",
    operationEventPositions: {
      "operation-a": "100",
      "operation-b": "99",
    },
    streamOffsets: { "stream-a": 0, "stream-b": 42 },
  });
  assertEquals(/^[A-Za-z0-9_-]+$/.test(cursor), true);
  assertEquals(decodeOperationReplayCursor(cursor), {
    eventPosition: "90071992547409931234",
    operationEventPositions: {
      "operation-a": "100",
      "operation-b": "99",
    },
    streamOffsets: { "stream-a": 0, "stream-b": 42 },
  });
  assertEquals(decodeOperationReplayCursor(undefined), { streamOffsets: {} });
});

Deno.test("operation replay cursor rejects malformed and unbounded positions", () => {
  assertThrows(() => decodeOperationReplayCursor("not+base64"), TypeError);
  assertThrows(() =>
    encodeOperationReplayCursor({
      eventPosition: "-1",
      streamOffsets: {},
    }), TypeError);
  assertThrows(() =>
    encodeOperationReplayCursor({
      streamOffsets: Object.fromEntries(
        Array.from(
          { length: MAX_OPERATION_CURSOR_STREAMS + 1 },
          (_, index) => [`stream-${index}`, index],
        ),
      ),
    }), TypeError);
});

Deno.test("operation replay cursor stays header-safe for 150 compact stream keys", () => {
  const cursor = encodeOperationReplayCursor({
    eventPosition: "123456789",
    streamOffsets: Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [
        operationStreamReplayCursorKey({
          replayKey: String(index + 1),
          streamId: `a-very-long-public-stream-id-${index}`,
        }),
        10_000_000 + index,
      ]),
    ),
  });

  // This leaves ample room for cookies and the rest of the request headers on
  // common managed HTTP frontends while representing a complex active run.
  assertLess(cursor.length, 4 * 1024);
  assertEquals(
    Object.keys(decodeOperationReplayCursor(cursor).streamOffsets).length,
    150,
  );
});

Deno.test("operation stream high-watermarks retain and then close sparse gaps", () => {
  const tracker = createOperationReplayCursorTracker({ streamOffsets: {} });
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
      streamId: "lane-two",
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
  const tracker = createOperationReplayCursorTracker({ streamOffsets: {} });
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
  const tracker = createOperationReplayCursorTracker({ streamOffsets: {} });
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
