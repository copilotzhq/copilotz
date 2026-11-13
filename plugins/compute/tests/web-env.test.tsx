/**
 * A space's environment on the web, drawn (as the server would draw it,
 * through React's own renderer): its Environment tab, for those who manage
 * the space and for its other members (a secret shows only that it's
 * there; one its computers get says what that means); and a job's own
 * environment as it's typed. The front end's resources name its Views.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Reached } from "../../access/spaces/contract.ts";
import type { EnvVar } from "../computers/contract.ts";
import { envSpaceView } from "../computers/views/web/env.tsx";
import { envLines, nameProblem, typedName } from "../computers/views/web/environment.ts";
import { envActionsOf } from "../computers/views/web/kinds.ts";
import { computersWeb } from "../computers/web.tsx";
import { test } from "../../../testing/mod.ts";

/** A View's context over fixed reads, by `<collection>.<query>`. */
function ctxOf(reads: Record<string, unknown>, viewer = "ana"): ViewContext<ReactNode> {
  return {
    db: {
      collection: (name: string) => ({
        query: (query: string) => ({ status: "ready", value: reads[`${name}.${query}`] }),
      }),
    } as unknown as ViewContext<ReactNode>["db"],
    resources: {},
    name: "test",
    viewer: { name: viewer },
    hints: {},
    show: () => null,
    call: () => Promise.resolve({} as never),
    emit: () => Promise.resolve(),
  };
}

const draw = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const spaceOf = (
  can: string[],
): Reached => ({ _id: "s1", name: "Acme", kind: "shared", can } as unknown as Reached);

const varOf = (over: Partial<EnvVar>): EnvVar => ({
  _id: `s1||${over.name}`,
  space: "s1",
  name: "API_URL",
  secret: false,
  computers: true,
  by: "ana",
  at: "2026-10-30T10:00:00.000Z",
  ...over,
});

const VARS = [
  varOf({ name: "API_URL", value: "https://api.acme.test" }),
  varOf({ name: "STRIPE_KEY", secret: true, hint: "••••9f2c" }),
  varOf({ name: "DEPLOY_TOKEN", secret: true, computers: false }),
];

test("a space's Environment tab: its variables, a secret only as there, who may change them", () => {
  const tab = (can: string[]) =>
    draw(envSpaceView(
      { _id: "s1" },
      ctxOf({ "envVar.here": VARS, "space.reached": [spaceOf(can)] }),
    ));
  const managed = tab(["read", "write", "manage"]);
  const shown = text(managed);
  assertStringIncludes(shown, "3 variables, 2 secret.");
  assertStringIncludes(shown, "API_URL");
  assertStringIncludes(shown, "https://api.acme.test");
  // A secret: that it's there, sealed, and a long one's last characters; never its value.
  assertStringIncludes(shown, "••••9f2c");
  assertStringIncludes(shown, "A secret, ending 9f2c");
  assertStringIncludes(shown, "••••••••");
  assertStringIncludes(shown, "Computers and apps");
  assertStringIncludes(shown, "Apps only");
  // A secret its computers get is marked: any process there can read it.
  assertStringIncludes(managed, "Any process on this space&#x27;s computers can read it");
  assertStringIncludes(managed, 'aria-label="Change STRIPE_KEY"');
  assertStringIncludes(managed, 'aria-label="Remove STRIPE_KEY"');
  assertStringIncludes(shown, "Add a variable");
  // Its dialog, for a new one: a secret given to computers says what that means.
  assertStringIncludes(shown, "New variable");
  assertStringIncludes(shown, "Give it to this space's computers");

  // Its other members see it, and change nothing.
  const member = tab(["read", "write"]);
  assert(!member.includes('aria-label="Change STRIPE_KEY"'));
  assert(!text(member).includes("Add a variable"));
  assertStringIncludes(text(member), "those who manage it change them");

  const empty = text(draw(envSpaceView(
    { _id: "s1" },
    ctxOf({ "envVar.here": [], "space.reached": [spaceOf(["read", "write", "manage"])] }),
  )));
  assertStringIncludes(empty, "No variables yet");
  assertStringIncludes(empty, "agents see only their names");

  // A section of the space's Computer tab.
  assertEquals(computersWeb.resources?.spaceTabs?.env, {
    title: "Environment",
    view: "env.space",
    icon: "lock",
    under: "computer",
    order: 10,
  });
  // What an app's own front ends draw under it (its `envActions` resource): its apps, as Compass's.
  assertEquals(envActionsOf({ apps: { view: "app.env-apply", order: 10 }, gone: null }), [
    { key: "apps", view: "app.env-apply", order: 10 },
  ]);
});

test("environment names as they're typed, and a job's own, one NAME=value a line", () => {
  assertEquals(typedName("api url"), "API_URL");
  assertEquals(typedName("my-key.v2!"), "MY_KEY_V2");
  assertEquals(nameProblem("API_URL"), undefined);
  assertEquals(nameProblem("2FA"), "A name can't start with a digit.");
  assertEquals(nameProblem(""), "It needs a name.");
  assertEquals(envLines(""), {});
  assertEquals(
    envLines("# for the dev server\nNODE_ENV=development\n\nexport DEBUG='app:*'\nURL=a=b"),
    { env: { NODE_ENV: "development", DEBUG: "app:*", URL: "a=b" } },
  );
  assertEquals(envLines("NODE_ENV development"), {
    error: "Line 1 isn't NAME=value: NODE_ENV development",
  });
});
