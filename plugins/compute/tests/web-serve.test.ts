/**
 * Computers and previews on the web, their logic: the kinds of computer
 * other front ends add, and which of the person's computers are of one; what
 * a job serves and its preview's address; a job to start from the form; and
 * an agent's ask to publish, in words.
 */
import { assert, assertEquals } from "@std/assert";
import type { Preview } from "../computers/collections/preview.ts";
import { addressOf, asked, publishOf, sentence } from "../computers/views/web/asked.ts";
import {
  blockedBy,
  jobActionsOf,
  kindByComputer,
  kindsOf,
  queryOf,
  titled,
} from "../computers/views/web/kinds.ts";
import {
  jobToStart,
  portsOf,
  previewOfJob,
  previewsAt,
  serves,
  shown,
} from "../computers/views/web/previews.ts";
import { test } from "../../../testing/mod.ts";

test("a kind that can't be made now says why, from its available query; otherwise it can", () => {
  const kind = {
    title: "Cloud computer",
    mine: "cloudComputer.mine",
    view: "cloud.computer",
    add: {
      view: "cloud.new",
      title: "Use a cloud computer",
      description: "…",
      available: "cloudComputer.sizes",
      unavailable: { admins: "Only admins.", default: "Not now." },
    },
  };
  assertEquals(blockedBy(kind, { create: false, why: "admins" }), "Only admins.");
  assertEquals(blockedBy(kind, { create: false, why: "budget" }), "Not now.");
  assertEquals(blockedBy(kind, { create: true }), undefined);
  // Still loading, or an app that doesn't say: it can be picked.
  assertEquals(blockedBy(kind, undefined), undefined);
  assertEquals(
    blockedBy({ ...kind, add: { ...kind.add, available: undefined } }, { create: false }),
    undefined,
  );
});

test("kinds of computer: in their order, complete ones only, and which computers are of one", () => {
  const kinds = kindsOf({
    later: { title: "Later", mine: "later.mine", view: "later.computer", order: 20 },
    cloud: {
      title: "Cloud computer",
      mine: "cloudComputer.mine",
      view: "cloud.computer",
      order: 10,
    },
    gone: null,
    broken: { title: "No query", mine: "nodot", view: "x" },
  });
  assertEquals(kinds.map((k) => k.key), ["cloud", "later"]);
  assertEquals(queryOf("cloudComputer.mine"), ["cloudComputer", "mine"]);
  assertEquals([queryOf("a.b.c"), queryOf("nodot"), queryOf("x.")], [
    ["a.b", "c"],
    undefined,
    undefined,
  ]);
  const of = kindByComputer(kinds, [[{ _id: "c1" }, { _id: "c2" }], undefined]);
  assertEquals(Object.keys(of), ["c1", "c2"]);
  assertEquals(of.c1.key, "cloud");
  assertEquals(titled("Delete {name}?", "Build box"), "Delete Build box?");
  assertEquals(
    jobActionsOf({ b: { view: "b", order: 2 }, a: { view: "a", order: 2 }, z: null }).map((a) =>
      a.key
    ),
    ["a", "b"],
  );
});

test("what a job serves, and its preview's address", () => {
  assertEquals(portsOf({ port: 3000, ports: [3000, 24678] }), [3000, 24678]);
  assertEquals(portsOf({ ports: [5173] }), [5173]);
  assertEquals(portsOf({}), []);
  assertEquals(serves({ running: true, ports: [8080] }), true);
  assertEquals(serves({ running: false, port: 8080 }), false);
  assertEquals(serves({ running: true }), false);
  assertEquals(shown("https://abc-preview.copilotz.app/"), "abc-preview.copilotz.app");
  const p = (over: Partial<Preview>): Preview => ({
    _id: "p",
    computer: "c1",
    space: "s1",
    folder: "acme",
    who: "person:ana",
    port: 3000,
    by: "ana",
    visibility: "members",
    at: "2026-10-30T10:00:00.000Z",
    ...over,
  });
  const previews = [
    p({ _id: "old", job: "j1", at: "2026-10-30T09:00:00.000Z" }),
    p({ _id: "new", job: "j1" }),
    p({ _id: "theirs", computer: "c2" }),
    p({ _id: "there", space: "s2" }),
  ];
  const here = previewsAt(previews, "c1", "s1");
  assertEquals(here.map((x) => x._id), ["new", "old"]);
  assertEquals(previewOfJob(here, "j1")?._id, "new");
  assertEquals(previewOfJob(here, "j2"), undefined);
});

test("a job to start, from the form: its port and whether it's kept", () => {
  assertEquals(jobToStart({ command: " npm run dev ", name: "", port: "", keep: false }), {
    command: "npm run dev",
  });
  assertEquals(jobToStart({ command: "npm start", name: "web", port: "3000", keep: true }), {
    command: "npm start",
    name: "web",
    port: 3000,
    keep: true,
  });
  assert("error" in jobToStart({ command: "x", name: "", port: "70000", keep: false }));
  assert("error" in jobToStart({ command: "  ", name: "", port: "", keep: false }));
});

test("an agent's ask to publish, in words", () => {
  const ask = {
    agent: "assistant",
    work: "publish",
    detail: "publish My Shop from job dev on port 3000 from web",
  };
  assertEquals(publishOf(ask.detail), { name: "My Shop", job: "dev", port: 3000, path: "web" });
  assertEquals(publishOf("publish Notes"), { name: "Notes" });
  assertEquals(publishOf("publish Site on port 8080"), { name: "Site", port: 8080 });
  assertEquals(asked(ask), { verb: "publish", wants: "wants to publish", what: "My Shop" });
  assertEquals(sentence(ask), "assistant wants to publish My Shop");
  const at = { ...ask, preview: "https://my-shop.copilotz.app" };
  assertEquals(addressOf(at), "https://my-shop.copilotz.app");
  assertEquals(addressOf({ work: "writes", preview: "https://x.app" }), undefined);
  assertEquals(sentence(at), "assistant wants to publish My Shop at https://my-shop.copilotz.app");
});
