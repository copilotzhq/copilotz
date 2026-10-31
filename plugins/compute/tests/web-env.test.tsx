/**
 * A space's environment on the web, drawn (as the server would draw it,
 * through React's own renderer): its Environment tab, for those who manage
 * the space and for its other members (a secret shows only that it's
 * there; one its computers get says what that means); a job's own
 * environment as it's typed; an app's environment, its own over the
 * space's, and what saving it changes; and the space's apps under its
 * environment, given it again. The front ends' resources name their Views.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Reached } from "../../access/spaces/contract.ts";
import type { AppDoc } from "../apps/collections/app.ts";
import { AppEnv, appEnvApplyView, changesOf } from "../apps/views/web/env.tsx";
import { appsSpaceView } from "../apps/views/web/space.tsx";
import { appsWeb } from "../apps/web.tsx";
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
    renderer: "web",
    kind: "test",
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

const appOf = (over: Partial<AppDoc> = {}): AppDoc => ({
  _id: "a1",
  space: "s1",
  by: "ana",
  name: "Shop",
  label: "shop",
  url: "https://shop.copilotz.app",
  source: { computer: "c1", port: 3000, job: "j1" },
  status: "live",
  at: "2026-10-30T10:00:00.000Z",
  ...over,
});

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

  assertEquals(computersWeb.resources?.spaceTabs?.env, {
    title: "Environment",
    view: "env.space",
    icon: "lock",
    order: 32,
  });
  assertEquals(envActionsOf(appsWeb.resources?.envActions), [
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

test("an app's environment: its own over the space's, and what saving it changes", () => {
  const own = [
    varOf({ _id: "s1|a1|API_URL", app: "a1", name: "API_URL", value: "https://shop.acme.test" }),
    varOf({ _id: "s1|a1|SHOP_SECRET", app: "a1", name: "SHOP_SECRET", secret: true }),
  ];
  const dialog = (editable: boolean) =>
    text(draw(
      <AppEnv
        app={appOf()}
        where="Acme"
        space={VARS}
        own={own}
        editable={editable}
        open
        onClose={() => {}}
        call={() => Promise.resolve({} as never)}
      />,
    ));
  const editing = dialog(true);
  assertStringIncludes(editing, "Shop's environment");
  assertStringIncludes(editing, "From Acme");
  // The space's API_URL is under its own.
  assertStringIncludes(editing, "API_URL https://api.acme.test its own over it");
  assertStringIncludes(editing, "STRIPE_KEY ••••9f2c");
  assertStringIncludes(editing, "Saving deploys it again with them, without a build.");
  assertStringIncludes(editing, "Deploy again");
  assertStringIncludes(editing, "Add a variable");
  // Seen by a member who can't change it.
  const seen = dialog(false);
  assertStringIncludes(seen, "API_URL https://shop.acme.test");
  assertStringIncludes(seen, "SHOP_SECRET secret");
  assert(!seen.includes("Deploy again"));

  // What saving sends: changed, new and gone; a secret left empty is kept.
  const rows = [
    { key: "1", name: "API_URL", value: "https://v2.acme.test", secret: false, had: own[0] },
    { key: "2", name: "SHOP_SECRET", value: "", secret: true, had: own[1] },
    { key: "3", name: "FEATURE", value: "on", secret: false },
  ];
  assertEquals(changesOf(own, rows), [
    { name: "API_URL", value: "https://v2.acme.test" },
    { name: "FEATURE", value: "on", secret: false },
  ]);
  assertEquals(changesOf(own, [rows[1]]), [{ name: "API_URL", remove: true }]);
  assertEquals(changesOf(own, [{ ...rows[0], value: "x", secret: true }, rows[1]]), [
    { name: "API_URL", value: "x", secret: true },
  ]);

  // The Apps tab offers it, and says how many of its own an app has.
  const tab = text(draw(appsSpaceView(
    { _id: "s1" },
    ctxOf({
      "app.here": [appOf()],
      "space.reached": [spaceOf(["read", "write", "manage"])],
      "desk.here": [],
      "envVar.here": VARS,
      "envVar.apps": own,
    }),
  )));
  assertStringIncludes(tab, "2 variables of its own");
  assertStringIncludes(tab, "Shop's environment");
});

test("a space's apps under its environment: given it again, by whoever may", () => {
  const apply = (apps: AppDoc[], can: string[], changed?: string, viewer = "ana") =>
    text(draw(appEnvApplyView(
      { _id: "s1", ...(changed ? { changed } : {}) },
      ctxOf({ "app.here": apps, "space.reached": [spaceOf(can)] }, viewer),
    )));
  const apps = [appOf(), appOf({ _id: "a2", name: "Blog", by: "bo" })];
  const managed = apply(apps, ["read", "write", "manage"]);
  assertStringIncludes(managed, "Its 2 apps get all of this");
  assertStringIncludes(managed, "Shop and Blog");
  assertStringIncludes(managed, "Apply to apps");
  // Changed from the page: they still run with it as it was.
  assertStringIncludes(
    apply(apps, ["read", "write", "manage"], "2026-10-30T11:00:00.000Z"),
    "Its apps still run with it as it was",
  );
  // A member gives it to theirs only; to none, no button.
  assertStringIncludes(apply(apps, ["read", "write"]), "Apply to yours");
  assert(!apply(apps, ["read", "write"], undefined, "cy").includes("Apply"));
  // No live apps: nothing.
  assertEquals(apply([appOf({ status: "failed" })], ["read", "write", "manage"]), "");
});
