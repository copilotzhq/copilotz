/**
 * Spaces on the rail, the sidebar folded (`spaces.rail`): the spaces in use that the tree lists as
 * the person's own, Personal first, each its face and a link to its page, named beside it; where
 * they work tinted, its page raised; archived spaces, and for an org's owner the org's others,
 * left to the tree. Invitations (`invitations.rail`): one mark counting them, that goes home,
 * where they're all listed; nothing on home itself, or with none.
 */
import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Invitation, Member, Reached } from "../spaces/contract.ts";
import { ORG } from "../spaces/shared/reach.ts";
import { invitationsRailView } from "../spaces/views/web/invitations.tsx";
import { spacesRailView } from "../spaces/views/web/spaces.tsx";

const noCall = () => Promise.resolve({} as never);

/** A View's context over fixed reads: queries by `<collection>.<query>`, finds by collection. */
const ctxOf = (
  reads: Record<string, unknown>,
  hints: Record<string, unknown> = {},
): ViewContext<ReactNode> => ({
  db: {
    collection: (name: string) => ({
      query: (query: string) => ({ status: "ready", value: reads[`${name}.${query}`] }),
      find: () => ({ status: "ready", value: reads[name] }),
    }),
  } as unknown as ViewContext<ReactNode>["db"],
  resources: {},
  name: "test",
  viewer: { name: "ana" },
  hints,
  show: () => null,
  call: noCall,
  emit: () => Promise.resolve(),
});

const at = "2026-11-14T09:00:00.000Z";
const space = (_id: string, name: string, more: Partial<Reached> = {}) =>
  ({ _id, name, kind: "shared", at, can: ["read", "write"], ...more }) as Reached;
const home = space("home", "personal:ana", { kind: "personal", owner: "ana" });
const launch = space("launch", "Launch");
const sales = space("sales", "Sales");
const old = space("old", "Old", { archived: at });
const member = (space: string, role = "editor") =>
  ({ _id: `${space}|person:ana`, space, member: "person:ana", role }) as Member;

const draw = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

/** The rail's items, in order: what each is named, and whether it's current. */
const items = (markup: string) =>
  [...markup.matchAll(/<a [^>]*>/g)].map(([a]) => {
    const label = /aria-label="([^"]*)"/.exec(a)?.[1];
    const current = /aria-current="([^"]*)"/.exec(a)?.[1];
    return current ? `${label} [${current}]` : label;
  });

test("the spaces in use, Personal first, each a face and a link, where you are marked", () => {
  const reads = {
    "space.reached": [sales, old, launch, home],
    member: [member("home", "manager"), member("launch"), member("sales")],
  };
  const markup = draw(
    spacesRailView({}, ctxOf(reads, { in: "launch", path: "/space/sales" })),
  );
  assertEquals(items(markup), ["Personal", "Launch [location]", "Sales [page]"]);
  assertStringIncludes(markup, 'href="/space/launch"');
  assertStringIncludes(markup, 'aria-label="Spaces"');
  // Each its face: a space's initial, and Personal's own mark.
  assertStringIncludes(markup, "copilotz-avatar-space");
  assertStringIncludes(markup, "spaces-personal");
  assertFalse(markup.includes("Old"));
});

test("for an org's owner, the spaces they're in and their Personal; the org's others wait", () => {
  const theirs = space("bob", "personal:bob", { kind: "personal", owner: "bob" });
  const reads = {
    "space.reached": [home, launch, sales, theirs],
    member: [member(ORG, "owner"), member("home", "manager"), member("launch")],
  };
  assertEquals(items(draw(spacesRailView({}, ctxOf(reads)))), ["Personal", "Launch"]);
});

test("nothing until the spaces are read", () => {
  assertEquals(draw(spacesRailView({}, ctxOf({ member: [] }))), "");
  assertEquals(draw(spacesRailView({}, ctxOf({ "space.reached": [home] }))), "");
});

test("invitations: one mark counting them, that goes home; none on home, or with none", () => {
  const invitation = (email: string) =>
    ({
      _id: email,
      space: "launch",
      name: "Launch",
      email,
      role: "editor",
      by: "bob",
      at,
    }) as Invitation;
  const two = { "invitation.mine": [invitation("a@x.com"), invitation("b@x.com")] };
  const markup = draw(invitationsRailView({}, ctxOf(two, { path: "/space/launch" })));
  assertEquals(items(markup), ["2 invitations to spaces"]);
  assertStringIncludes(markup, 'href="/"');
  assertStringIncludes(markup, ">2</span>");
  assertEquals(draw(invitationsRailView({}, ctxOf(two, { path: "/" }))), "");
  assertEquals(
    draw(invitationsRailView({}, ctxOf({ "invitation.mine": [] }, { path: "/space/launch" }))),
    "",
  );
});
