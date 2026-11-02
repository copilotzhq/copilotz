/** Gift codes in the directory: shown once, kept hashed, claimed by one org, typed any way. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRuntime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { directory } from "../directory/mod.ts";
import { identity } from "../identity/mod.ts";
import { test } from "../../../testing/mod.ts";

async function setup(fn: (rt: Awaited<ReturnType<typeof createRuntime>>) => Promise<void>) {
  const rt = await createRuntime({ store: memoryStore(), plugins: [identity, directory] });
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
}

const made = (rt: Awaited<ReturnType<typeof createRuntime>>, input: Record<string, unknown> = {}) =>
  rt.call<{ code: string; id: string }>("code.create", { amount: 10, by: "sam", ...input });

test("a code is shown once, kept only as its hash, and in no event", async () => {
  await setup(async (rt) => {
    const { code, id } = await made(rt, { note: "launch" });
    assert(/^GIFT-[0-9A-Z-]+$/.test(code));
    assert(code.replace(/\W/g, "").length >= 26, "too long to guess");
    const { codes } = await rt.call<{ codes: Record<string, unknown>[] }>("code.list", {});
    assertEquals([codes[0].id, codes[0].amount, codes[0].note], [id, 10, "launch"]);
    assert(!JSON.stringify(codes).includes(code));
  });
});

test("one org claims it; the same org again gets the same, another is refused", async () => {
  await setup(async (rt) => {
    const { code, id } = await made(rt, { expires: "2027-01-01", note: "launch" });
    const first = await rt.call("code.claim", { code, org: "o1", person: "ana" });
    assertEquals(first, { id: id.slice(0, 16), amount: 10, expires: "2027-01-01", note: "launch" });
    assertEquals(await rt.call("code.claim", { code, org: "o1", person: "ana" }), first);
    await assertRejects(
      () => rt.call("code.claim", { code, org: "o2", person: "bob" }),
      Error,
      "already been used",
    );
  });
});

test("however it's typed; a wrong one, an expired one and a revoked one say so", async () => {
  await setup(async (rt) => {
    const { code } = await made(rt);
    const typed = code.toLowerCase().replaceAll("-", " ");
    assertEquals(
      (await rt.call<{ amount: number }>("code.claim", { code: typed, org: "o1", person: "a" }))
        .amount,
      10,
    );
    await assertRejects(
      () => rt.call("code.claim", { code: "GIFT-NOPE", org: "o1", person: "a" }),
      Error,
      "isn't valid",
    );
    const old = await made(rt, { until: "2020-01-01T00:00:00.000Z" });
    await assertRejects(
      () => rt.call("code.claim", { code: old.code, org: "o1", person: "a" }),
      Error,
      "expired",
    );
    const taken = await made(rt);
    await rt.call("code.revoke", { id: taken.id });
    await assertRejects(
      () => rt.call("code.claim", { code: taken.code, org: "o1", person: "a" }),
      Error,
      "isn't valid",
    );
    // One that's been claimed can't be taken back.
    const { codes } = await rt.call<{ codes: { id: string; org?: string }[] }>("code.list", {});
    await assertRejects(() => rt.call("code.revoke", { id: codes.find((c) => c.org)!.id }));
  });
});

test("claimed at once from two places, one gets it", async () => {
  await setup(async (rt) => {
    const { code } = await made(rt);
    const answers = await Promise.allSettled(
      ["o1", "o2", "o3"].map((org) => rt.call("code.claim", { code, org, person: "a" })),
    );
    assertEquals(answers.filter((a) => a.status === "fulfilled").length, 1);
  });
});
