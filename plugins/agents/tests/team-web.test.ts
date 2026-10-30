/**
 * Agents as team's web front end makes them: what a new one is called by,
 * finding one among those someone knows, what a new one starts with, names
 * in a sentence, and the spaces someone makes them in.
 */
import { assertEquals } from "@std/assert";
import type { Agent } from "../chat/mod.ts";
import {
  agentPath,
  found,
  handleOf,
  listed,
  shownAs,
  usualTools,
} from "../team/views/web/agents.ts";
import { managed, manages, placeName, placePath } from "../team/views/web/places.ts";
import { test } from "../../../testing/mod.ts";

test("what a new agent is called by, as agent.create makes it, and its page", () => {
  assertEquals(handleOf("Maya"), "maya");
  assertEquals(handleOf("  Ana Lúcia  da Silva "), "ana-lucia-da-silva");
  assertEquals(handleOf("🦉"), "agent");
  assertEquals(handleOf("Maya", (id) => ["maya", "maya-2"].includes(id)), "maya-3");
  assertEquals(handleOf("x".repeat(40)).length, 32);
  assertEquals(shownAs("maya", { name: "Maya", icon: "🦉" }), { name: "Maya", icon: "🦉" });
  assertEquals(shownAs("researcher"), { name: "researcher" });
  assertEquals(agentPath("maya"), "/agent/maya");
  assertEquals(agentPath("maya-2", true), "/agent/maya-2?edit=1");
});

test("finding an agent someone knows: every word, in its names or what it does", () => {
  const agents = [
    { id: "maya", name: "Maya", description: "Writes launch copy" },
    { id: "researcher", name: "researcher", description: "Digs into a question" },
    { id: "ecrivain", name: "Écrivain" },
  ];
  assertEquals(found(agents, "").map((a) => a.id), ["maya", "researcher", "ecrivain"]);
  assertEquals(found(agents, "@maya").map((a) => a.id), ["maya"]);
  assertEquals(found(agents, "LAUNCH copy").map((a) => a.id), ["maya"]);
  assertEquals(found(agents, "ecri").map((a) => a.id), ["ecrivain"]);
  assertEquals(found(agents, "maya digs"), []);
});

test("what a new agent starts with, and names in a sentence", () => {
  const known: Record<string, Agent> = {
    assistant: { instructions: "", model: "m", default: true, tools: ["clock", "send_message"] },
    researcher: { instructions: "", model: "m", tools: ["web_search"] },
    maya: { instructions: "", model: "m", in: "launch", tools: ["roll_dice"] },
  };
  // The app's usual agent's tools, those that may be given; else messaging others.
  assertEquals(usualTools(known, ["clock", "send_message", "roll_dice"]), [
    "clock",
    "send_message",
  ]);
  assertEquals(usualTools(known, ["roll_dice", "send_message"]), ["send_message"]);
  assertEquals(usualTools({}, ["clock"]), []);
  assertEquals([listed(["a"]), listed(["a", "b"]), listed(["a", "b", "c"])], [
    "a",
    "a and b",
    "a, b and c",
  ]);
});

test("the spaces someone makes agents in: those they manage, in use, Personal first", () => {
  const place = (name: string, can: string[], more = {}) => ({
    _id: name.toLowerCase(),
    name,
    kind: "shared",
    can,
    ...more,
  });
  const places = [
    place("Launch", ["read", "write", "manage"]),
    place("Board", ["read"]),
    place("Old", ["read", "write", "manage"], { archived: "2026-10-01T00:00:00Z" }),
    place("personal:ana", ["read", "write", "manage"], { kind: "personal" }),
    place("design", ["read", "write", "manage"]),
  ];
  assertEquals(managed(places).map((p) => p._id), ["personal:ana", "design", "launch"]);
  assertEquals([manages(places[0]), manages(places[1]), manages(undefined)], [true, false, false]);
  assertEquals(places.map(placeName).slice(3), ["Personal", "design"]);
  assertEquals(placePath("a b", "members"), "/space/a%20b?tab=members");
});
