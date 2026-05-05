import { assertEquals, assertRejects } from "@std/assert";
import {
  mergeResourceArrays,
  resolveResourceList,
} from "./merge-resources.ts";

Deno.test("resolveResourceList returns preload when input is undefined", async () => {
  const preload = [{ id: "a", v: 1 }];
  assertEquals(await resolveResourceList(preload, undefined), preload);
});

Deno.test("resolveResourceList merges array like mergeResourceArrays explicit", async () => {
  const preload = [
    { id: "x", n: 1 },
    { id: "y", n: 2 },
  ];
  const out = await resolveResourceList(preload, [{ id: "x", n: 9 }]);
  assertEquals(out, [{ id: "x", n: 9 }, { id: "y", n: 2 }]);
});

Deno.test("resolveResourceList sync callback replaces list", async () => {
  const preload = [{ id: "a", v: 1 }];
  const out = await resolveResourceList(preload, (loaded) =>
    loaded.map((r) => ({ ...r, v: 2 }))
  );
  assertEquals(out, [{ id: "a", v: 2 }]);
});

Deno.test("resolveResourceList async callback", async () => {
  const preload = [{ id: "a", v: 1 }];
  const out = await resolveResourceList(preload, async (loaded) => {
    await Promise.resolve();
    return loaded;
  });
  assertEquals(out, preload);
});

Deno.test("resolveResourceList rejects non-array callback result", async () => {
  await assertRejects(
    () => resolveResourceList([{ id: "a" }], () => null as unknown as never[]),
    TypeError,
    "Resource list resolver must return an array",
  );
});

Deno.test("mergeResourceArrays nested equivalence with preload pattern", () => {
  const bundled = [{ id: "b" }, { id: "c" }];
  const user = [{ id: "b", from: "user" }];
  const explicit = [{ id: "c", from: "cfg" }];

  const nested = mergeResourceArrays(
    bundled,
    mergeResourceArrays(user, explicit, { prioritize: "explicit" }),
    { prioritize: "explicit" },
  );

  const preload = mergeResourceArrays(bundled, user, {
    prioritize: "explicit",
  });
  const flat = mergeResourceArrays(preload, explicit, {
    prioritize: "explicit",
  });

  assertEquals(nested, flat);
});
