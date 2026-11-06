/**
 * The API's front end, as React draws it: a space's keys among its members
 * (whose each is, how it works there, what it may use; revoking for its
 * person and the space's managers), and the person's own keys in the API tab.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Reached } from "../../../access/spaces/contract.ts";
import type { ApiKey } from "../contract.ts";
import { presets } from "../resources/presets.ts";
import { memberKeysView } from "../views/web/members.tsx";
import { keysView } from "../views/web/keys.tsx";
import { test } from "../../../../testing/mod.ts";

const key = (more: Partial<ApiKey>): ApiKey => ({
  _id: "k1",
  person: "ana",
  in: "team",
  name: "Support bot",
  hint: "cpz_abcd",
  role: "editor",
  scope: presets.chat.scope,
  at: "2026-11-05T09:00:00.000Z",
  ...more,
});

const keys = [
  key({}),
  key({
    _id: "k2",
    person: "bob",
    name: "Reporting",
    role: "viewer",
    scope: presets.read.scope,
    used: "2026-11-06T08:00:00.000Z",
  }),
];

/** A View over fixed reads (the space's keys, `here`), as `viewer`, with `hints`. */
const draw = (
  view: (item: { _id?: string }, ctx: ViewContext<ReactNode>) => ReactNode,
  viewer: string,
  hints: Record<string, unknown> = {},
  here: ApiKey[] = keys,
) => {
  const reads: Record<string, unknown> = {
    api_key: here,
    "api_key.mine": here.filter((k) => k.person === viewer),
    "profile.names": { ana: "Ana", bob: "Bob" },
    space: { _id: "team", name: "Team", kind: "shared" },
    "space.reached": [{ _id: "team", name: "Team", can: ["read", "write"] } as Reached],
  };
  const ctx = {
    db: {
      collection: (name: string) => ({
        query: (query: string) => ({ status: "ready", value: reads[`${name}.${query}`] }),
        find: () => ({ status: "ready", value: reads[name] ?? [] }),
        findOne: () => ({ status: "ready", value: reads[name] ?? null }),
      }),
    },
    resources: { apiPresets: presets, names: { people: { collection: "profile" } } },
    medium: "web",
    kind: "api",
    viewer: { name: viewer },
    hints,
    show: () => null,
    call: () => Promise.resolve({}),
    emit: () => Promise.resolve(),
  } as unknown as ViewContext<ReactNode>;
  return renderToStaticMarkup(<>{view({ _id: "team" }, ctx)}</>)
    .replace(/<style[\s\S]*?<\/style>/g, "");
};

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

test("among the members: each key, whose, how it works here and what it may use", () => {
  const shown = text(draw(memberKeysView, "ana", { in: "team", manage: false }));
  assertStringIncludes(shown, "Developer keys 2");
  assertStringIncludes(shown, "Support bot Yours Your key · Chat");
  assertStringIncludes(shown, "Reporting Bob's · Read only · Used");
  assertStringIncludes(shown, "Editor");
  assertStringIncludes(shown, "Viewer");
});

test("among the members: its person revokes theirs; the space's managers, any", () => {
  const revokes = (html: string) =>
    [...html.matchAll(/aria-label="Revoke ([^"]+)"/g)].map((m) => m[1]);
  assertEquals(revokes(draw(memberKeysView, "ana", { in: "team", manage: false })), [
    "Support bot",
  ]);
  assertEquals(revokes(draw(memberKeysView, "cy", { in: "team", manage: true })), [
    "Support bot",
    "Reporting",
  ]);
});

test("among the members: nothing when the space has no keys", () => {
  assertEquals(draw(memberKeysView, "ana", { in: "team" }, []), "");
});

test("the API tab: the person's own keys, each with what it may use and how it works here", () => {
  const shown = text(draw(keysView, "ana", {}));
  assertStringIncludes(shown, "Support bot Chat");
  assertStringIncludes(shown, "Editor here");
  assert(!shown.includes("Reporting"), "someone else's key isn't in her tab");
  // Trying it: what its scope lets it do.
  assertStringIncludes(shown, "Send a message");
});
