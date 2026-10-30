/**
 * Cloud computers, previews and apps on the web, their logic: the kinds of
 * computer other front ends add, and which of the person's computers are
 * of one; what a job serves and its preview's address; a job to start from
 * the form; an agent's ask to publish, in words; a cloud computer's sizes,
 * prices, states, time awake and wake; and an app's address, status and
 * folder.
 */
import { assert, assertEquals } from "@std/assert";
import type { Preview } from "../computers/collections/preview.ts";
import { addressOf, asked, publishOf, reach, sentence } from "../computers/views/web/asked.ts";
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
import {
  awakeFor,
  costOf,
  duration,
  lookOf,
  money,
  progress,
  refusalOf,
  sizesOf,
  specsOf,
  spent,
  stillWaking,
  suggestedName,
  WAKE_MS,
} from "../cloud/views/web/cloud.ts";
import {
  addressFor,
  appOfJob,
  domainOf as appsDomainOf,
  folderOf,
  lookOf as appLookOf,
  suggestedName as appName,
} from "../apps/views/web/apps.ts";
import type { AppDoc } from "../apps/collections/app.ts";
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
  assertEquals(reach("once", ask, "laptop"), "assistant may publish My Shop, this once.");
  assertEquals(
    reach("thread", ask, "laptop"),
    "assistant may publish apps from laptop without asking again, in this conversation.",
  );
  // The others read as before.
  assertEquals(
    reach("always", { agent: "a", work: "jobs", detail: "x" }),
    "a may start jobs on this computer without asking again, in any conversation.",
  );
});

test("a cloud computer's sizes and prices, as people pay them", () => {
  const sizes = sizesOf({
    sizes: [
      { id: "small", label: "Small", vcpu: 2, memory: 4, shared: true, hour: 0.4 },
      { id: "standard", label: "Standard", vcpu: 2, memory: 8, hour: null },
      { id: "broken" },
    ],
    disk: { gb: 10, gbMonth: 0.2, snapshotGbMonth: null },
  });
  assertEquals(sizes.sizes.map((s) => [s.id, s.shared ?? false, s.hour]), [
    ["small", true, 0.4],
    ["standard", false, null],
  ]);
  assertEquals(sizes.disk, { gb: 10, gbMonth: 0.2, snapshotGbMonth: null });
  // An app that says nothing: 10 GB, the usual minutes, and anyone may try.
  assertEquals(sizesOf(undefined), {
    sizes: [],
    disk: { gb: 10, gbMonth: null, snapshotGbMonth: null },
    warmMinutes: 10,
    viewMinutes: 120,
    create: true,
  });
  // What the app says of the person: may they make one, and why not.
  const refused = sizesOf({ sizes: [], warmMinutes: 15, create: false, why: "budget" });
  assertEquals([refused.warmMinutes, refused.create, refused.why], [15, false, "budget"]);
  assertEquals(sizesOf({ create: false, why: "nonsense" }).why, undefined);
  assertEquals([money(0.4), money(0.0335), money(12), money(0.05)], [
    "$0.40",
    "$0.034",
    "$12.00",
    "$0.05",
  ]);
  assertEquals([spent(0.004), spent(0.08)], ["under 1¢", "about $0.08"]);
  assertEquals(specsOf({ vcpu: 2, memory: 4 }), "2 vCPU · 4 GB");
});

test("a cloud computer's states, time awake and wake, as people read them", () => {
  assertEquals(
    (["awake", "asleep", "cold", "waking", "releasing"] as const).map((s) => lookOf(s).label),
    ["Awake", "Asleep", "Sleeping deeply", "Waking", "Going to sleep"],
  );
  assertEquals([lookOf("waking").busy, lookOf("asleep").busy], [true, false]);
  assertEquals(
    [0, 59_000, 12 * 60_000, 65 * 60_000, 120 * 60_000].map(duration),
    ["less than a minute", "less than a minute", "12 min", "1 h 5 min", "2 h"],
  );
  const now = Date.parse("2026-10-30T10:12:00.000Z");
  assertEquals(awakeFor({ state: "awake", woke: "2026-10-30T10:00:00.000Z" }, now), 720_000);
  assertEquals(awakeFor({ state: "asleep", woke: "2026-10-30T10:00:00.000Z" }, now), undefined);
  assertEquals(costOf(720_000, 0.4)?.toFixed(2), "0.08");
  assertEquals(costOf(720_000, null), undefined);
  // An estimate: quick at first, about 80% at the usual time, never done.
  assertEquals(progress(0, WAKE_MS.asleep), 0);
  assert(progress(WAKE_MS.asleep, WAKE_MS.asleep) > 0.75);
  assertEquals(progress(10 * WAKE_MS.cold, WAKE_MS.cold), 0.95);
  const waking = Object.assign(new Error("The computer is waking: try again in a minute."), {
    code: "unavailable",
  });
  const broke = Object.assign(new Error("The computer couldn't wake: no capacity"), {
    code: "unavailable",
  });
  assertEquals([stillWaking(waking), stillWaking(broke), stillWaking(null)], [true, false, false]);
  assertEquals(
    [
      refusalOf(Object.assign(new Error("no"), { code: "forbidden" })),
      refusalOf(Object.assign(new Error("spent"), { code: "budget" })),
      refusalOf(new Error("other")),
    ],
    ["forbidden", "budget", undefined],
  );
  assertEquals([suggestedName("Acme"), suggestedName("Personal"), suggestedName()], [
    "Acme cloud",
    "My cloud computer",
    "My cloud computer",
  ]);
});

test("an app's address, status and folder, as publishing shows them", () => {
  assertEquals(addressFor("Café Shop!", "copilotz.app"), "https://cafe-shop.copilotz.app");
  assertEquals(addressFor("  ", "copilotz.app"), undefined);
  const app = (over: Partial<AppDoc>): AppDoc => ({
    _id: "a1",
    space: "s1",
    by: "ana",
    name: "Shop",
    label: "shop",
    url: "https://shop.apps.test",
    source: { computer: "c1", port: 3000, job: "j1" },
    status: "live",
    at: "2026-10-30T10:00:00.000Z",
    ...over,
  });
  assertEquals(appsDomainOf([app({})]), "apps.test");
  assertEquals(appsDomainOf([]), "copilotz.app");
  assertEquals(
    (["building", "live", "failed"] as const).map((status) => appLookOf({ status }).label),
    ["Building", "Live", "Failed"],
  );
  const apps = [app({ _id: "gone", status: "removed" }), app({})];
  assertEquals(appOfJob(apps, "j1", "c1")?._id, "a1");
  assertEquals(appOfJob(apps, "j1", "c2"), undefined);
  assertEquals([folderOf(""), folderOf("./web/"), folderOf("/site\\public")], [
    {},
    { path: "web" },
    { path: "site/public" },
  ]);
  assert("error" in folderOf("../elsewhere"));
  assertEquals(appName({ name: "web", command: "npm run dev" }, "~/Copilotz/acme"), "web");
  assertEquals(appName({ name: "npm run dev", command: "npm run dev" }, "~/Copilotz/acme"), "acme");
  assertEquals(appName({ name: "npm start", command: "npm start" }), "app");
});
