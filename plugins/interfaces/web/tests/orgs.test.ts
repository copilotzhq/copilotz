/**
 * Orgs in the shell, its part of them: roles in words, who runs an org, the
 * person's menu, and the `orgs` slot a front end fills (or none does).
 */
import { assertEquals } from "@std/assert";
import { orgRoleName, orgsSlotOf, runs } from "../shared/orgs.ts";
import { userMenuOf } from "../shared/menu.ts";
import { test } from "../../../../testing/mod.ts";

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

test("the orgs slot: drawn where a front end names its switcher, and nowhere else", () => {
  const use = () => undefined;
  assertEquals(orgsSlotOf(undefined), undefined);
  assertEquals(orgsSlotOf(null), undefined);
  assertEquals(orgsSlotOf({ overlay: "orgs.overlay" }), undefined);
  assertEquals(orgsSlotOf({ switcher: "" }), undefined);
  assertEquals(orgsSlotOf({ switcher: "orgs.switcher", overlay: "orgs.overlay", use }), {
    switcher: "orgs.switcher",
    overlay: "orgs.overlay",
    use,
  });
});
