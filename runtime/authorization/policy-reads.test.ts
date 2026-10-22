import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { policyReadValues, trackPolicyReads } from "./policy-reads.ts";

const input = () => ({
  authority: {
    principal: { id: "member" },
    requestFacts: { input: { nonce: "a", thread: "thread" } },
  },
  intent: { invocation: { runId: "one" }, input: { ids: ["a", "b"] } },
});
Deno.test("policy observations match only inspected paths, including missing fields", () => {
  const first = input();
  const tracker = trackPolicyReads(first);
  const authority = tracker.value<typeof first.authority>("authority");
  assertEquals(authority.principal.id, "member");
  assertEquals(Reflect.get(authority.requestFacts.input, "absent"), undefined);
  const observed = tracker.finish();
  const next = input();
  next.authority.requestFacts.input.nonce = "b";
  next.intent.invocation.runId = "two";
  assertEquals(policyReadValues(next, observed.reads), observed.values);
  next.authority.principal.id = "other";
  assertNotEquals(policyReadValues(next, observed.reads), observed.values);
  next.authority.principal.id = "member";
  Reflect.set(next.authority.requestFacts.input, "absent", true);
  assertNotEquals(policyReadValues(next, observed.reads), observed.values);
});
Deno.test("policy enumeration, spreads, JSON and descriptors track complete values", () => {
  for (
    const inspect of [
      (value: object) => Object.keys(value),
      (value: object) => ({ ...value }),
      (value: object) => JSON.stringify(value),
      (value: object) => Object.getOwnPropertyDescriptors(value),
    ]
  ) {
    const data = input();
    const tracker = trackPolicyReads(data);
    inspect(tracker.value("authority"));
    const observed = tracker.finish();
    data.authority.requestFacts.input.nonce = "changed";
    assertNotEquals(policyReadValues(data, observed.reads), observed.values);
  }
  const data = input(), tracker = trackPolicyReads(data);
  Object.keys(
    tracker.context({
      authority: tracker.value("authority"),
      intent: tracker.value("intent"),
    }),
  );
  const observed = tracker.finish();
  data.intent.invocation.runId = "two";
  assertNotEquals(policyReadValues(data, observed.reads), observed.values);
});
Deno.test("policy JSON arrays preserve iteration and track inspected elements", () => {
  const data = input(), tracker = trackPolicyReads(data);
  const intent = tracker.value<typeof data.intent>("intent");
  assertEquals([...intent.input.ids], ["a", "b"]);
  assertEquals(intent.input.ids.map((s) => s.toUpperCase()), ["A", "B"]);
  const observed = tracker.finish();
  assert(observed.lifetime.valid);
  data.intent.input.ids[1] = "c";
  assertNotEquals(policyReadValues(data, observed.reads), observed.values);
});
Deno.test("policy views reject mutation, non-JSON, output escapes and late access", () => {
  assertThrows(() => trackPolicyReads({ bad: new Date() }));
  assertThrows(() => trackPolicyReads({ bad: () => 1 }));
  const tracker = trackPolicyReads(input());
  const authority = tracker.value<object>("authority");
  assertThrows(() => Object.assign(authority, { forged: true }));
  assertEquals(tracker.lifetime.valid, false);
  const other = trackPolicyReads(input());
  const escaped = other.value("intent");
  other.escapes({ filter: escaped });
  assertEquals(other.finish().lifetime.valid, false);
  const third = trackPolicyReads(input());
  const late = third.value<object>("authority");
  third.finish();
  assertEquals(Reflect.get(late, "principal").id, "member");
  assert(!third.lifetime.valid);
});

Deno.test("enumeration fingerprints preserve JSON property order", () => {
  const tracker = trackPolicyReads({ intent: { first: 1, second: 2 } });
  Object.keys(tracker.value<object>("intent"));
  const saved = tracker.finish();
  assertNotEquals(
    policyReadValues({ intent: { second: 2, first: 1 } }, saved.reads),
    saved.values,
  );
});

Deno.test("policy JSON views preserve frozen descriptors and never expose raw children", () => {
  const tracker = trackPolicyReads(input());
  const authority = tracker.value<object>("authority");
  assert(Object.isFrozen(authority));
  const child = Object.getOwnPropertyDescriptor(authority, "principal")!;
  assertEquals(child.writable, false);
  assert(Object.isFrozen(child.value));
  assertThrows(() => {
    child.value.id = "forged";
  });
  assertEquals(child.value.id, "member");
  assert(!tracker.finish().lifetime.valid);
});
