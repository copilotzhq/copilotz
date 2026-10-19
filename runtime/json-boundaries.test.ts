import { assert, assertEquals, assertThrows } from "@std/assert";
import { assertJsonValue } from "./json.ts";
import { captureHostCommandJson } from "./application/host-command-json.ts";
import { snapshotStreamMetadata } from "./streams/json.ts";
import { createHostCommands } from "./application/host-commands.ts";
import type { HostCommandJson } from "./application/host-command-types.ts";
import type {
  CommandCaller,
  CommandRequest,
  DatabaseOwner,
} from "./engine/commands.ts";
import { canonicalContentJson } from "./content/json.ts";
import {
  decodeCapability,
  encodeCapability,
  OWNER_CAPABILITY_BYTES,
} from "./execution/owner-capability-wire.ts";

const stream = (value: unknown) => snapshotStreamMetadata({ value });
const boundaries = [
  assertJsonValue,
  captureHostCommandJson,
  stream,
  encodeCapability,
];

Deno.test("data-only boundaries reject executable and hidden properties without invoking hooks", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error("hook invoked");
  };
  const getter = (key: PropertyKey) =>
    Object.defineProperty({}, key, { enumerable: true, get: trap });
  const array = [1];
  Object.defineProperty(array, "0", { enumerable: true, get: trap });
  const cycle: Record<string, unknown> = {};
  cycle.child = [cycle];
  for (
    const value of [
      getter("value"),
      getter("toJSON"),
      getter(Symbol.iterator),
      array,
      { toJSON: trap },
      { [Symbol.iterator]: trap },
      Object.defineProperty({}, "hidden", { value: 1 }),
      { [Symbol("key")]: 1 },
      cycle,
      new Array(1),
      Object.assign([1], { extra: 2 }),
      Object.assign(new Array(1), { extra: 2 }),
      { value: NaN },
      { value: Infinity },
      { value: -Infinity },
      { value: 1n },
      { value: Symbol("value") },
      { value: trap },
    ]
  ) {
    for (const capture of boundaries) assertThrows(() => capture(value));
  }
  for (const capture of [assertJsonValue, captureHostCommandJson, stream]) {
    assertThrows(() => capture([undefined]));
  }
  // Capability's explicit undefined tag is separate from JSON-only capture.
  assertEquals(decodeCapability(encodeCapability([undefined])), [undefined]);
  assertEquals(calls, 0);
});

Deno.test("data-only boundaries retain their distinct array, prototype and numeric policies", () => {
  const hiddenElement = Object.defineProperty([1], "0", { enumerable: false });
  assertEquals(captureHostCommandJson(hiddenElement), [1]);
  for (const capture of [assertJsonValue, stream, encodeCapability]) {
    assertThrows(() => capture(hiddenElement));
  }
  const array = [1];
  Object.setPrototypeOf(array, null);
  assertJsonValue(array);
  assertEquals(captureHostCommandJson(array), [1]);
  assertEquals(decodeCapability(encodeCapability(array)), [1]);
  assertThrows(() => stream(array));
  const object = Object.assign(Object.create(null), { value: 1 });
  assertJsonValue(object);
  assertThrows(() => captureHostCommandJson(object));
  assertThrows(() => snapshotStreamMetadata(object));
  assertEquals(decodeCapability(encodeCapability(object)), { value: 1 });
  assertJsonValue(-0);
  assertThrows(() => assertJsonValue(-0, { rejectNegativeZero: true }));
  assert(Object.is(captureHostCommandJson(-0), 0));
  assert(Object.is(stream(-0).value, -0));
  assertThrows(() => encodeCapability(-0), Error, "owner_data_invalid");
  assertJsonValue({ omitted: undefined }, { omitUndefinedProperties: true });
  assertThrows(() =>
    assertJsonValue([undefined], { omitUndefinedProperties: true })
  );
  assertJsonValue(new Uint8Array([1]), { allowBytes: true });
  assertThrows(() => assertJsonValue(new Uint8Array([1])));
});

Deno.test("captures detach shared noncycles, preserve key order and safely copy special names", () => {
  const shared = { z: [1, -0], a: "original" };
  const source = {
    z: shared,
    a: shared,
    ...JSON.parse('{"__proto__":{"x":1}}'),
  };
  assertJsonValue(source);
  const host = captureHostCommandJson(source) as typeof source;
  const metadata = snapshotStreamMetadata(source) as typeof source;
  const bytes = encodeCapability({ z: host.z, a: host.a });
  shared.a = "changed";
  shared.z.push(2);
  for (const copy of [host, metadata]) {
    assertEquals(Object.keys(copy), ["z", "a", "__proto__"]);
    assertEquals(Object.getPrototypeOf(copy), Object.prototype);
    assert(Object.hasOwn(copy, "__proto__"));
    assert(copy.z !== copy.a);
    assertEquals(copy.z.a, "original");
    assertEquals(copy.z.z.length, 2);
    assert(Object.isFrozen(copy));
    assert(Object.isFrozen(copy.z));
    assert(Object.isFrozen(copy.z.z));
  }
  assertEquals(decodeCapability(bytes), {
    z: { z: [1, 0], a: "original" },
    a: { z: [1, 0], a: "original" },
  });
});

Deno.test("validation and metadata limits count the root and repeated occurrences exactly", () => {
  const value = { a: [1, 2] };
  assertJsonValue(value, { maxDepth: 2, maxNodes: 4 });
  assertThrows(
    () => assertJsonValue(value, { maxDepth: 1 }),
    TypeError,
    "depth",
  );
  assertThrows(
    () => assertJsonValue(value, { maxNodes: 3 }),
    TypeError,
    "node count",
  );
  assertEquals(
    snapshotStreamMetadata(value, { maxDepth: 2, maxNodes: 4 }),
    value,
  );
  assertThrows(() => snapshotStreamMetadata(value, { maxDepth: 1 }));
  assertThrows(() => snapshotStreamMetadata(value, { maxNodes: 3 }));
  const shared = {};
  assertJsonValue([shared, shared], { maxNodes: 3 });
  assertThrows(() => assertJsonValue([shared, shared], { maxNodes: 2 }));
  assertJsonValue({ a: undefined }, {
    maxNodes: 1,
    omitUndefinedProperties: true,
  });
  assertThrows(() => assertJsonValue(null, { maxNodes: 0 }));
  assertThrows(() => snapshotStreamMetadata({}, { maxNodes: 0 }));
});

Deno.test("host and capability depth and node budgets retain their inclusive boundaries", () => {
  let nested: unknown = 1;
  for (let depth = 0; depth < 64; depth++) nested = [nested];
  captureHostCommandJson(nested);
  encodeCapability(nested);
  assertThrows(
    () => captureHostCommandJson([nested]),
    RangeError,
    "too complex",
  );
  assertThrows(() => encodeCapability([nested]), Error, "owner_data_limit");
  const nodes = Array(99_999).fill(0);
  captureHostCommandJson(nodes);
  encodeCapability(nodes);
  nodes.push(0);
  assertThrows(() => captureHostCommandJson(nodes), RangeError, "too complex");
  assertThrows(() => encodeCapability(nodes), Error, "owner_data_limit");
});

Deno.test("host conservative charges and stream exact byte limits stay unchanged", () => {
  const limit = 1024 * 1024;
  captureHostCommandJson("x".repeat(limit - 2));
  assertThrows(
    () => captureHostCommandJson("x".repeat(limit - 1)),
    RangeError,
    "1 MiB",
  );
  // Host charges two separators per property and five bytes for null/booleans.
  const host = { a: null, b: "x".repeat(limit - 19) };
  captureHostCommandJson(host);
  assertThrows(
    () => captureHostCommandJson({ ...host, b: host.b + "x" }),
    RangeError,
    "1 MiB",
  );
  for (const text of ["", "text", "\u0000", "\ud800", "😀", 'é水\n"\\']) {
    const input = { text, flag: true, empty: null, number: -0 };
    const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
    assertEquals(snapshotStreamMetadata(input, { maxBytes: bytes }), input);
    assertThrows(() => snapshotStreamMetadata(input, { maxBytes: bytes - 1 }));
  }
  const capability = "x".repeat(OWNER_CAPABILITY_BYTES - 6);
  assertEquals(encodeCapability(capability).length, OWNER_CAPABILITY_BYTES);
  assertThrows(
    () => encodeCapability(capability + "x"),
    Error,
    "owner_data_limit",
  );
});

Deno.test("canonical content and tagged receipt intent retain historical bytes and key ordering", () => {
  const input = JSON.parse(
    '{"z":-0,"2":"two","10":"ten","a":{"z":"\\ud800","a":"😀"},"__proto__":null}',
  );
  const host = captureHostCommandJson(input);
  assertEquals(
    JSON.stringify(host),
    '{"2":"two","10":"ten","z":0,"a":{"z":"\\ud800","a":"😀"},"__proto__":null}',
  );
  assertEquals(
    canonicalContentJson(host),
    '{"10":"ten","2":"two","__proto__":null,"a":{"a":"😀","z":"\\ud800"},"z":0}',
  );
  assertEquals(
    new TextDecoder().decode(
      encodeCapability({
        plan: [],
        options: { operationKey: "same|key", text: "\ud800😀" },
      }),
    ),
    '[3,[["plan",[2,[]]],["options",[3,[["operationKey",[1,"same|key"]],["text",[1,"\\ud800😀"]]]]]]]',
  );
});

Deno.test("capture boundaries retain snapshot versus per-property descriptor timing", () => {
  const input = () => {
    const source = { first: {}, later: 1 };
    source.first = new Proxy({}, {
      getPrototypeOf(target) {
        source.later = 2;
        return Reflect.getPrototypeOf(target);
      },
    });
    return source;
  };
  assertEquals(captureHostCommandJson(input()), { first: {}, later: 2 });
  assertEquals(snapshotStreamMetadata(input()), { first: {}, later: 1 });
  let hooks = 0;
  const array = [1];
  Object.setPrototypeOf(array, {
    toJSON() {
      hooks++;
      throw new Error("toJSON");
    },
    get [Symbol.iterator]() {
      hooks++;
      throw new Error("iterator");
    },
  });
  assertJsonValue(array);
  assertEquals(captureHostCommandJson(array), [1]);
  assertEquals(decodeCapability(encodeCapability(array)), [1]);
  assertThrows(() => stream(array));
  assertEquals(hooks, 0);
});

Deno.test("host admission retains the historical logical receipt identity tuple", async () => {
  let captured: CommandRequest<HostCommandJson> | undefined;
  const signal = new AbortController().signal;
  const owner = {
    signal,
    epoch: 7,
    ready: Promise.resolve(),
    register:
      () =>
      (_caller: CommandCaller, request: CommandRequest<HostCommandJson>) => {
        captured = request;
        return Promise.resolve(request.input);
      },
  } as unknown as DatabaseOwner;
  const host = createHostCommands({
    defaultSchema: "command_test",
    signal,
    admit: () => Promise.resolve(),
    openScope: () => Promise.resolve(),
    definitions: {
      echo: {
        namespace: "space|one",
        principal: "service",
        authorize() {},
        execute: (input) => input,
      },
    },
  });
  host.install("command_test", owner);
  await host.commands.invoke("echo", { z: -0, a: "😀\ud800" }, {
    idempotencyKey: "same|key",
  });
  assertEquals(captured?.receipt, {
    identity: {
      domain: "logical",
      key:
        '["host.command.v1","command_test","space|one","echo","service","same|key"]',
    },
    intent: { z: 0, a: "😀\ud800" },
  });
});
