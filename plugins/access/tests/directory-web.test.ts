/**
 * The directory's front end, its logic: the browser's orgs (a server with
 * many answers them, one with one org answers none; an org changed in the
 * page asks again), the org page's sections (from the plugins that add them)
 * in order and for whom, someone's standing in a word, and staff's console
 * searched and filtered, with its gift codes.
 */
import { assert, assertEquals } from "@std/assert";
import { orgsChanged } from "../../interfaces/web/contract.ts";
import {
  asStaff,
  currentOrg,
  loadOrgs,
  orgName,
  type Orgs,
  refreshOrgs,
} from "../directory/views/web/orgs.ts";
import { codeStatus, newCodeOf } from "../directory/views/web/codes.ts";
import {
  chosenSection,
  consoleList,
  consoleTotals,
  SCHEMA,
  sectionsOf,
  standingName,
} from "../directory/views/web/lists.ts";
import { test } from "../../../testing/mod.ts";

const SECTIONS = {
  usage: { title: "Usage", view: "usage.org", order: 30 },
  about: { title: "About", view: "org.about", order: 10 },
  members: {
    title: "Members",
    view: "org.members",
    order: 20,
    roles: ["owner", "admin", "member"],
  },
  billing: { title: "Billing", view: "billing.org", order: 40, roles: ["owner"] },
  gone: null,
  broken: { title: "Nothing" },
};

test("the org page's sections, in order, for whom they are; staff see them all", () => {
  const keys = (role: string | null, staff = false) =>
    sectionsOf(SECTIONS, { role, staff }).map((s) => s.key);
  assertEquals(keys("owner"), ["about", "members", "usage", "billing"]);
  assertEquals(keys("member"), ["about", "members", "usage"]);
  assertEquals(keys("guest"), ["about", "usage"]);
  assertEquals(keys(null, true), ["about", "members", "usage", "billing"]);
  assertEquals(sectionsOf(undefined, { role: "owner", staff: false }), []);
  const shown = sectionsOf(SECTIONS, { role: "member", staff: false });
  assertEquals(chosenSection(shown, "members")?.key, "members");
  assertEquals(chosenSection(shown, "billing")?.key, "about");
});

test("someone's standing in a word: their role, or staff", () => {
  assertEquals(standingName({ role: null, staff: true }), "Staff");
  assertEquals(standingName({ role: "admin", staff: true }), "Admin");
});

test("the console: searched by name, id, schema or maker, filtered, the most active first", () => {
  const orgs = [
    {
      id: "o-1",
      name: "Acme",
      kind: "team",
      by: "ana",
      members: 4,
      placement: { schema: "orgs" },
      summary: { people: 5, active: "2026-10-29T10:00:00Z" },
      at: "2026-10-01T00:00:00Z",
    },
    {
      id: "p-2",
      name: "bob",
      kind: "personal",
      by: "bob",
      members: 1,
      placement: { schema: "orgs" },
      at: "2026-10-28T00:00:00Z",
    },
    {
      id: "o-3",
      name: "Beta Labs",
      kind: "team",
      by: "carol",
      members: 2,
      suspended: true,
      placement: { schema: "org_beta" },
      summary: { active: "2026-10-27T00:00:00Z" },
      at: "2026-09-01T00:00:00Z",
    },
  ];
  const ids = (search: string, filter: "all" | "team" | "personal" | "suspended" = "all") =>
    consoleList(orgs, search, filter).map((o) => o.id);
  assertEquals(ids(""), ["o-1", "p-2", "o-3"]);
  assertEquals(ids("beta"), ["o-3"]);
  assertEquals(ids("org_beta"), ["o-3"]);
  assertEquals(ids("carol labs"), ["o-3"]);
  assertEquals(ids("", "team"), ["o-1", "o-3"]);
  assertEquals(ids("", "suspended"), ["o-3"]);
  assertEquals(ids("", "personal"), ["p-2"]);
  assertEquals(consoleTotals(orgs), { orgs: 3, teams: 2, people: 8, suspended: 1 });
  assertEquals(["org_big", "Org", "1big", "big-one"].map((s) => SCHEMA.test(s)), [
    true,
    false,
    false,
    false,
  ]);
});

test("the browser's orgs: a server with many answers them; one with one org, none", async () => {
  const orgs: Orgs = {
    person: "ana",
    email: "ana@example.com",
    current: "o-1",
    orgs: [{ id: "p-1", name: "ana", kind: "personal" }, { id: "o-1", name: "Acme", kind: "team" }],
    invites: [],
    staff: false,
    asStaff: false,
  };
  const fetched = globalThis.fetch;
  try {
    globalThis.fetch = (() => Promise.resolve(Response.json(orgs))) as typeof fetch;
    const many = await refreshOrgs();
    assertEquals(many.status === "ready" && many.here?.name, "Acme");
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
      )) as typeof fetch;
    assertEquals((await refreshOrgs()).status, "none");
    assertEquals((await loadOrgs()).status, "none");
  } finally {
    globalThis.fetch = fetched;
  }
  assertEquals(currentOrg(orgs)?.id, "o-1");
  assertEquals(orgName(orgs.orgs[0]), "Personal");
  assertEquals(asStaff(orgs), false);
  // Staff in an org of their own are its people, until they go in as staff.
  assertEquals(asStaff({ ...orgs, staff: true }), false);
  assertEquals(asStaff({ ...orgs, staff: true, asStaff: true }), true);
});

test("an org changed in the page (renamed): the browser's orgs are asked again", async () => {
  const fetched = globalThis.fetch;
  let asked = 0;
  try {
    globalThis.fetch = (() => {
      asked++;
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof fetch;
    await refreshOrgs();
    assertEquals(asked, 1);
    await loadOrgs();
    assertEquals(asked, 1);
    orgsChanged();
    await new Promise((done) => setTimeout(done, 0));
    assertEquals(asked, 2);
  } finally {
    globalThis.fetch = fetched;
  }
});

test("gift codes in the console: where each stands, and what's asked for", () => {
  const code = {
    id: "x",
    short: "abc",
    amount: 25,
    by: "sam",
    at: "2026-11-01T00:00:00Z",
  };
  const now = "2026-11-15T00:00:00.000Z";
  assertEquals(codeStatus(code, now), "waiting");
  assertEquals(codeStatus({ ...code, org: "o", claimed: now }, now), "claimed");
  assertEquals(codeStatus({ ...code, revoked: now }, now), "revoked");
  assertEquals(codeStatus({ ...code, until: "2026-11-02T00:00:00.000Z" }, now), "expired");
  assertEquals(newCodeOf({ amount: "$1,000", expires: "", until: "", note: " " }), {
    amount: 1000,
  });
  assertEquals(
    newCodeOf({ amount: "25", expires: "2027-01-01", until: "2026-12-01", note: "Hi" }),
    { amount: 25, expires: "2027-01-01", until: "2026-12-01T23:59:59.999Z", note: "Hi" },
  );
  assert("error" in newCodeOf({ amount: "nope", expires: "", until: "", note: "" }));
  assert("error" in newCodeOf({ amount: "0", expires: "", until: "", note: "" }));
});
