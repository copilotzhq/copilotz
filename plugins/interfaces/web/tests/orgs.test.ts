/**
 * Orgs in the shell, their logic: the org page's sections (from the plugins
 * that add them) in order and for whom, roles in words, who runs an org,
 * staff's console searched and filtered, and the person's menu.
 */
import { assertEquals } from "@std/assert";
import {
  chosenSection,
  consoleList,
  consoleTotals,
  orgRoleName,
  runs,
  SCHEMA,
  sectionsOf,
  standingName,
} from "../shared/orgs.ts";
import { userMenuOf } from "../shared/menu.ts";
import { test } from "../../../../testing/mod.ts";

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

test("roles in words, and who runs the org", () => {
  assertEquals([orgRoleName("owner"), orgRoleName("guest"), orgRoleName("custom")], [
    "Owner",
    "Guest",
    "Custom",
  ]);
  assertEquals(orgRoleName(null), "");
  assertEquals(
    [
      runs({ role: "owner", staff: false }),
      runs({ role: "admin", staff: false }),
      runs({ role: "member", staff: false }),
      runs({ role: null, staff: true }),
      runs(undefined),
    ],
    [true, true, false, true, false],
  );
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

test("the person's menu: what front ends put there, in order", () => {
  assertEquals(
    userMenuOf({
      keys: { label: "API keys", href: "/keys", order: 20 },
      accounts: { label: "Connected accounts", icon: "lock", href: "/accounts", order: 10 },
      gone: null,
      broken: { label: "No address" },
    }),
    [
      { label: "Connected accounts", icon: "lock", href: "/accounts", order: 10 },
      { label: "API keys", href: "/keys", order: 20 },
    ],
  );
  assertEquals(userMenuOf(undefined), []);
});
