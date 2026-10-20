import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { canonicalContentJson } from "./json.ts";
import { createContentPreparer } from "./preparer.ts";
import { encodeEventBody } from "../events/body-store.ts";

Deno.test("new inline JSON captures use stable recursive bytes across retained input and preserve array/scalar semantics", async () => {
  const value = {
    z: [{ z: "é𝄞\ud800", a: null }, true, false, 0, -0, 1.25, 1e30],
    a: { "10": "ten", "2": "two", empty: "" },
  };
  const serialized = canonicalContentJson(value);
  assertEquals(JSON.parse(serialized), {
    z: [{ z: "é𝄞\ud800", a: null }, true, false, 0, 0, 1.25, 1e30],
    a: { "10": "ten", "2": "two", empty: "" },
  });
  const input = { type: "json" as const, value };
  const retained = JSON.parse((await encodeEventBody({ input })).body).input;
  const prepare = createContentPreparer();
  const first = await prepare.prepare(input, { namespace: "space" });
  const second = await prepare.prepare(retained, { namespace: "space" });
  assertEquals(first.assets[0].digest, second.assets[0].digest);
  assertEquals(first.assets[0].body, second.assets[0].body);
  assertEquals(new TextDecoder().decode(first.assets[0].body), serialized);
  const canonical = await prepare.prepare(first.content, {
    namespace: "space",
  });
  assertEquals(canonical.assets, []);
  assertEquals(canonical.content, first.content);
  for (const scalar of [null, true, false, "é", 0, 1.5]) {
    assertEquals(canonicalContentJson(scalar), JSON.stringify(scalar));
  }
});
Deno.test("inline JSON canonical bytes refuse unsupported values without evaluating accessors", async () => {
  let accessed = false;
  const getter = {
    get value() {
      accessed = true;
      return 1;
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (
    const value of [
      undefined,
      NaN,
      Infinity,
      1n,
      () => 1,
      Symbol("x"),
      new Uint8Array([1]),
      new Date(),
      [, 1],
      { a: undefined },
      getter,
      cycle,
    ]
  ) assertThrows(() => canonicalContentJson(value));
  assertEquals(accessed, false);
  for (const value of [NaN, Infinity, 1n, { a: undefined }]) {
    await assertRejects(() =>
      createContentPreparer().prepare({ type: "json", value }, {
        namespace: "space",
      })
    );
  }
});
