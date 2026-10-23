import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  decodeCapability,
  encodeCapability,
  OWNER_CAPABILITY_BYTES,
} from "./owner-capability-wire.ts";
import {
  awaitOperation,
  isActionContinuation,
} from "../actions/continuation.ts";
import { ActionError } from "../actions/errors.ts";
import { isNonRetryableError, markNonRetryable } from "../failure.ts";
Deno.test("capability codec preserves explicit absence, bytes, typed failures and continuations", () => {
  const input = {
    missing: undefined,
    empty: null,
    bytes: new Uint8Array([0, 1, 255]),
    date: new Date(0),
  };
  const output = decodeCapability(encodeCapability(input)) as typeof input;
  assertEquals(output, input);
  assert(Object.hasOwn(output, "missing"));
  input.bytes[0] = 8;
  assertEquals(output.bytes[0], 0);
  const error = decodeCapability(
    encodeCapability(
      markNonRetryable(
        new ActionError("safe", { code: "denied", status: 403 }),
      ),
    ),
  );
  assert(error instanceof ActionError);
  assertEquals(error.status, 403);
  assertEquals(error.code, "denied");
  assert(isNonRetryableError(error));
  assert(
    isActionContinuation(
      decodeCapability(
        encodeCapability(
          awaitOperation({ operationId: "child", handoff: { cursor: 1 } }),
        ),
      ),
    ),
  );
});
Deno.test("capability codec rejects accessors, cycles, executable and oversized values before transport", () => {
  let getters = 0;
  const getter = {
    get value() {
      getters++;
      return "unsafe";
    },
  };
  const error = new Error();
  Object.defineProperty(error, "code", {
    get() {
      getters++;
      return "unsafe";
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (
    const value of [getter, error, cyclic, () => 1, new Map(), {
      signal: new AbortController().signal,
    }]
  ) assertThrows(() => encodeCapability(value));
  assertEquals(getters, 0);
  assertThrows(() => encodeCapability(new Uint8Array(OWNER_CAPABILITY_BYTES)));
  assertThrows(() =>
    decodeCapability(
      new TextEncoder().encode(
        JSON.stringify([3, [["a", [1, 1]], ["a", [1, 2]]]]),
      ),
    )
  );
});

Deno.test("codec bounds scalar, aggregate keys and escaped strings before serialization", () => {
  const stringify = JSON.stringify;
  let serialized = 0;
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    serialized++;
    return stringify(...args);
  }) as typeof stringify;
  try {
    for (
      const input of [
        "a".repeat(OWNER_CAPABILITY_BYTES + 1),
        { first: "a".repeat(600_000), second: "b".repeat(600_000) },
        { ["a".repeat(600_000)]: 1, ["b".repeat(600_000)]: 2 },
        "\u0000".repeat(200_000),
        "\ud800".repeat(200_000),
        new Error("e".repeat(OWNER_CAPABILITY_BYTES)),
      ]
    ) {
      assertThrows(() => encodeCapability(input), Error, "owner_data_limit");
    }
    assertEquals(serialized, 0);
  } finally {
    JSON.stringify = stringify;
  }
  const fits = "a".repeat(OWNER_CAPABILITY_BYTES - 6);
  assertEquals(encodeCapability(fits).length, OWNER_CAPABILITY_BYTES);
});

Deno.test("codec uses trusted Date and byte intrinsics without subclass hooks", () => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error("hostile hook");
  };
  const date = new Date(0);
  Object.defineProperties(date, {
    getTime: { get: trap },
    toISOString: { get: trap },
    toJSON: { get: trap },
  });
  class HostileBytes extends Uint8Array {
    static get [Symbol.species]() {
      hooks++;
      return Uint8Array;
    }
  }
  const bytes = new HostileBytes([1, 2, 255]);
  Object.defineProperties(bytes, {
    length: { get: trap },
    subarray: { get: trap },
    [Symbol.iterator]: { get: trap },
    constructor: { get: trap },
  });
  const output = decodeCapability(encodeCapability({ date, bytes })) as {
    date: Date;
    bytes: Uint8Array;
  };
  assertEquals(output.date, new Date(0));
  assertEquals(output.bytes, new Uint8Array([1, 2, 255]));
  const continuation = awaitOperation({ operationId: "child", handoff: null });
  Object.defineProperty(continuation, "handoff", {
    get: trap,
    enumerable: true,
  });
  assertThrows(
    () => encodeCapability(continuation),
    Error,
    "owner_data_invalid",
  );
  assertEquals(hooks, 0);
});

Deno.test("codec bounds Error cause traversal by the same depth budget", () => {
  let value = new Error("leaf");
  for (let index = 0; index < 65; index++) {
    value = new Error("parent", { cause: value });
  }
  assertThrows(() => encodeCapability(value), Error, "owner_data_limit");
  let getters = 0;
  const hostile = new Error();
  Object.defineProperty(hostile, "cause", {
    get() {
      getters++;
      return new Error();
    },
  });
  assertThrows(() => encodeCapability(hostile), Error, "owner_data_invalid");
  assertEquals(getters, 0);
});

Deno.test("capability errors retain explicit retryability and bounded retry delay without their cause", () => {
  const error = Object.assign(
    new Error("provider unavailable", {
      cause: new Error("private diagnostic"),
    }),
    {
      retryable: true,
      retryAfterMs: 5000,
      code: "llm_provider_network",
    },
  );
  const decoded = decodeCapability(encodeCapability(error)) as Error & {
    retryable?: boolean;
    retryAfterMs?: number;
    code?: string;
  };
  assertEquals(decoded.retryable, true);
  assertEquals(decoded.retryAfterMs, 5000);
  assertEquals(decoded.code, "llm_provider_network");
  assertEquals(decoded.cause, undefined);
  assertEquals(
    (decodeCapability(
      encodeCapability(new Error("ordinary")),
    ) as typeof decoded).retryable,
    undefined,
  );
  assertEquals(
    (decodeCapability(
      encodeCapability(Object.assign(error, { retryAfterMs: 999999 })),
    ) as typeof decoded).retryAfterMs,
    30_000,
  );
});
