/**
 * Cloud computers, previews and apps on the web, drawn (as the server would
 * draw them, through React's own renderer): a cloud computer's state badge,
 * its facts, and its page asleep; making one (sizes with their price an
 * active hour, what it means, a name); adding a computer as a choice; a
 * space's computers with a cloud one; a job that serves a port, before and
 * after its preview, and the previews list; an agent's ask to publish;
 * publishing a job, and a space's apps. The front ends' resources name
 * their Views as computers' pages read them.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { CloudComputer } from "../cloud/contract.ts";
import type { AppDoc } from "../apps/collections/app.ts";
import type { Preview } from "../computers/collections/preview.ts";
import type { Computer } from "../computers/collections/computer.ts";
import type { Desk } from "../computers/collections/desk.ts";
import type { Job } from "../computers/shared/workloads.ts";
import type { Reached } from "../../access/spaces/contract.ts";
import { cloudComputerView } from "../cloud/views/web/computer.tsx";
import { cloudNewView } from "../cloud/views/web/new.tsx";
import { cloudWeb } from "../cloud/web.tsx";
import { appsWeb } from "../apps/web.tsx";
import { appPublishView, AppStatus } from "../apps/views/web/publish.tsx";
import { appsSpaceView } from "../apps/views/web/space.tsx";
import { AddChoices, AddDialog } from "../computers/views/web/add.tsx";
import { Desks } from "../computers/views/web/desks.tsx";
import { jobActionsOf, kindsOf } from "../computers/views/web/kinds.ts";
import { JobServe, Previews, type Served } from "../computers/views/web/serve.tsx";
import { stepView } from "../computers/views/web/step.tsx";
import { test } from "../../../testing/mod.ts";

/** A View's context over fixed reads, by `<collection>.<query>`. */
function ctxOf(
  reads: Record<string, unknown>,
  hints: Record<string, unknown> = {},
): ViewContext<ReactNode> {
  return {
    db: {
      collection: (name: string) => ({
        query: (query: string) => ({ status: "ready", value: reads[`${name}.${query}`] }),
        find: () => ({ status: "ready", value: (reads[name] ?? []) as never }),
      }),
    } as unknown as ViewContext<ReactNode>["db"],
    resources: {},
    renderer: "web",
    kind: "test",
    viewer: { name: "ana" },
    hints,
    show: () => null,
    call: () => Promise.resolve({} as never),
    emit: () => Promise.resolve(),
  };
}

/** What's drawn, as text: tags out, entities read. */
const draw = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").replace(/ ,/g, ",")
    .trim();

const SIZES = {
  sizes: [
    { id: "small", label: "Small", vcpu: 2, memory: 4, shared: true, hour: 0.4 },
    { id: "standard", label: "Standard", vcpu: 2, memory: 8, hour: 0.9 },
  ],
  disk: { gb: 10, gbMonth: 0.2, snapshotGbMonth: 0.1 },
};

const cloudOf = (over: Partial<CloudComputer> = {}): CloudComputer => ({
  _id: "c1",
  owner: "ana",
  size: "small",
  placement: { project: "p", zone: "z" },
  disk: "d",
  diskGb: 10,
  state: "asleep",
  used: "2026-10-30T09:00:00.000Z",
  at: "2026-10-29T09:00:00.000Z",
  ...over,
});

test("a cloud computer's state, facts and page asleep, drawn", () => {
  const reads = (state: CloudComputer["state"], more: Partial<CloudComputer> = {}) => ({
    "cloudComputer.mine": [cloudOf({ state, ...more })],
    "cloudComputer.sizes": SIZES,
  });
  const badge = (state: CloudComputer["state"]) =>
    text(draw(cloudComputerView({ _id: "c1" }, ctxOf(reads(state), { mode: "badge" }))));
  assertEquals(badge("awake"), "Awake");
  assertEquals(badge("asleep"), "Asleep");
  assertEquals(badge("cold"), "Sleeping deeply");
  assertEquals(badge("waking"), "Waking…");
  assertEquals(badge("releasing"), "Going to sleep…");
  // Not one of theirs: nothing.
  assertEquals(cloudComputerView({ _id: "other" }, ctxOf(reads("awake"), { mode: "badge" })), null);

  const woke = new Date(Date.now() - 12 * 60_000 - 5_000).toISOString();
  const facts = text(
    draw(cloudComputerView({ _id: "c1" }, ctxOf(reads("awake", { woke }), { mode: "facts" }))),
  );
  assertStringIncludes(facts, "Cloud · Small (2 vCPU · 4 GB)");
  assertStringIncludes(facts, "10 GB disk");
  assertStringIncludes(facts, "Awake for 12 min · about $0.08 so far");

  const asleep = (state: CloudComputer["state"]) =>
    text(draw(cloudComputerView(
      { _id: "c1", desk: "k1", name: "Build box" },
      ctxOf(reads(state), { mode: "asleep" }),
    )));
  assertStringIncludes(asleep("asleep"), "Build box is asleep");
  assertStringIncludes(asleep("asleep"), "Wake it");
  assertStringIncludes(asleep("asleep"), "You pay while it's awake ($0.40 an hour)");
  assertStringIncludes(asleep("cold"), "Build box is sleeping deeply");
  assertStringIncludes(asleep("cold"), "about half a minute");
  assertStringIncludes(asleep("waking"), "Waking Build box…");
  assertStringIncludes(asleep("waking"), "Usually a few seconds.");
  const waking = draw(cloudComputerView(
    { _id: "c1", desk: "k1", name: "Build box" },
    ctxOf(reads("waking"), { mode: "asleep" }),
  ));
  assertStringIncludes(waking, 'role="progressbar"');
  assertStringIncludes(asleep("releasing"), "Build box is going to sleep");
});

test("making a cloud computer: its sizes, what an active hour costs, what it means, a name", () => {
  const html = draw(cloudNewView(
    { _id: "s1" },
    ctxOf({ "cloudComputer.sizes": SIZES }, {
      in: "s1",
      where: "Acme",
    }),
  ));
  const said = text(html);
  assertStringIncludes(said, "Small 2 vCPU · 4 GB memory Shared CPU");
  assertStringIncludes(said, "$0.40 per active hour");
  assertStringIncludes(said, "Standard 2 vCPU · 8 GB memory Dedicated CPU");
  assertStringIncludes(said, "$0.90 per active hour");
  assertStringIncludes(
    said,
    "You pay while it's awake; it sleeps after 10 minutes unused. Its 10 GB disk is kept while it " +
      "sleeps, at $0.20 per GB-month.",
  );
  assertStringIncludes(html, 'value="Acme cloud"');
  assertStringIncludes(said, "Create computer");
  // Radios, in a fieldset with its legend: chosen by keyboard as any.
  assertEquals(html.match(/type="radio"/g)?.length, 2);
  assertStringIncludes(html, "<legend");
  // Nothing offered: it says so.
  assertStringIncludes(
    text(draw(cloudNewView({ _id: "s1" }, ctxOf({ "cloudComputer.sizes": { sizes: [] } })))),
    "doesn't offer any sizes",
  );
});

const space: Reached = {
  _id: "s1",
  name: "Acme",
  kind: "shared",
  can: ["read", "write", "manage"],
} as unknown as Reached;
const kinds = kindsOf(cloudWeb.resources?.computerKinds);

test("adding a computer: a cloud computer or your own machine, as a choice", () => {
  assertEquals(kinds.map((k) => [k.key, k.view, k.add?.view, k.remove?.action]), [
    ["cloud", "cloud.computer", "cloud.new", "cloud.destroy"],
  ]);
  const choices = text(draw(<AddChoices kinds={kinds} pick={() => {}} />));
  assertStringIncludes(choices, "Use a cloud computer Ready in seconds");
  assertStringIncludes(choices, "Connect your own machine Your Mac, Linux or Windows computer");
  const laptop = { _id: "c9", owner: "ana", secret: "", online: false, at: "", name: "Laptop" };
  const dialog = text(draw(
    <AddDialog
      step="choose"
      go={() => {}}
      onClose={() => {}}
      call={() => Promise.resolve({} as never)}
      computers={[laptop]}
      space="s1"
      where="Acme"
      kinds={kinds}
      kindOf={{}}
      others={[laptop]}
      share={() => {}}
    />,
  ));
  assertStringIncludes(dialog, "Add a computer to Acme");
  assertStringIncludes(dialog, "Or add one of yours Laptop Offline");
  // A space with none: the choices as cards; with a cloud one, its state's place.
  const none = text(draw(
    <Desks
      space={space}
      desks={[]}
      mine={[]}
      choose={() => {}}
      me="ana"
      call={() => Promise.resolve({} as never)}
      kinds={kinds}
    />,
  ));
  assertStringIncludes(none, "No computer in Acme yet");
  assertStringIncludes(none, "Use a cloud computer");
  const desk: Desk = {
    _id: "k1",
    in: "s1",
    computer: "c1",
    owner: "ana",
    folder: "acme",
    online: false,
    answers: "asker",
    at: "",
    name: "Build box",
  } as Desk;
  const one = text(draw(
    <Desks
      space={space}
      desks={[desk]}
      mine={[{ _id: "c1", owner: "ana", secret: "", online: false, at: "" } as Computer]}
      choose={() => {}}
      me="ana"
      call={() => Promise.resolve({} as never)}
      kinds={kinds}
      kindOf={{ c1: kinds[0] }}
    />,
  ));
  assertStringIncludes(one, "Build box Yours · Cloud computer");
  assert(!one.includes("Offline"), one);
});

const job: Job = {
  id: "j1",
  who: "person:ana",
  name: "web",
  command: "npm run dev",
  pid: 1,
  running: true,
  exitCode: null,
  startedAt: "2026-10-30T10:00:00.000Z",
  port: 3000,
  ports: [3000, 24678],
};
const preview: Preview = {
  _id: "abcdefghij-preview",
  computer: "c1",
  space: "s1",
  folder: "acme",
  who: "person:ana",
  port: 3000,
  job: "j1",
  by: "ana",
  visibility: "members",
  at: "2026-10-30T10:01:00.000Z",
};
const served = (previews: Preview[]): Served => ({
  call: () => Promise.resolve({} as never),
  space: "s1",
  computer: "c1",
  folder: "~/Copilotz/acme",
  previews,
  actions: jobActionsOf(appsWeb.resources?.jobActions),
});

test("a job that serves a port: its preview, before and after", () => {
  const before = text(draw(<JobServe job={job} title="web" served={served([])} />));
  assertStringIncludes(before, "Serves ports 3000, 24678");
  assertStringIncludes(
    before,
    "Preview Preview for space members Preview for anyone with the link",
  );
  assertStringIncludes(before, "Preview port 24678");
  const after = draw(<JobServe job={job} title="web" served={served([preview])} />);
  assertStringIncludes(text(after), "Space members");
  assertStringIncludes(text(after), "Open preview");
  // Its address isn't known until the app says the domain: it doesn't open yet.
  assert(!after.includes("-preview."), after);
  // No previews: no list (each row says when it was made, as the toolkit's `Time`, drawn live).
  assertEquals(draw(<Previews served={served([])} jobs={[job]} me="ana" />), "");
  assertEquals(jobActionsOf(appsWeb.resources?.jobActions).map((a) => a.view), ["app.publish"]);
});

const appOf = (over: Partial<AppDoc>): AppDoc => ({
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

test("publishing a job, and a space's apps, live", () => {
  const item = {
    in: "s1",
    computer: "c1",
    job: "j1",
    name: "web",
    command: "npm run dev",
    port: 3000,
    folder: "~/Copilotz/acme",
  };
  const publish = (apps: AppDoc[]) => text(draw(appPublishView(item, ctxOf({ "app.here": apps }))));
  assertStringIncludes(publish([]), "Publish");
  assertStringIncludes(publish([appOf({ status: "building" })]), "Building…");
  assertStringIncludes(publish([appOf({})]), "Published");
  assertStringIncludes(
    publish([appOf({ status: "failed", error: "no Dockerfile" })]),
    "Publish failed",
  );
  // Its dialog's form: the name, the address it makes, the folder and the port.
  const form = publish([]);
  assertStringIncludes(form, "web.copilotz.app");
  assertStringIncludes(form, "…/acme/");
  assertStringIncludes(form, "run with npm run dev");

  const tab = (apps: AppDoc[]) =>
    text(draw(appsSpaceView(
      { _id: "s1" },
      ctxOf({
        "app.here": apps,
        "space.reached": [space],
        "desk.here": [{ computer: "c1", name: "Build box" }],
      }),
    )));
  assertStringIncludes(tab([]), "No apps yet");
  // An app as it goes (each row of the list says when, as the toolkit's live `Time`).
  const status = (app: AppDoc) =>
    text(draw(<AppStatus app={app} call={() => Promise.resolve({} as never)} />));
  assertStringIncludes(status(appOf({ status: "building" })), "Building Shop…");
  assertStringIncludes(status(appOf({ status: "building" })), "shop.copilotz.app once it's live");
  assertStringIncludes(status(appOf({})), "Shop is live shop.copilotz.app");
  assertStringIncludes(status(appOf({})), "Publish again");
  const failed = status(appOf({ status: "failed", error: "Build failed: no start command" }));
  assertStringIncludes(failed, "Couldn't publish Shop");
  assertStringIncludes(failed, "Build failed: no start command");
  assertStringIncludes(failed, "Try again");
  // Live, with its last publish failed: the version before is still live.
  const kept = status(appOf({ error: "Build failed" }));
  assertStringIncludes(kept, "Its last publish failed");
  assertStringIncludes(kept, "still live");
  assertEquals(appsWeb.resources?.spaceTabs, {
    apps: { title: "Apps", view: "app.space", icon: "globe", order: 35 },
  });
});

test("a tool step says the computer it ran on, where the space has several; a computer that can't be used says why", () => {
  const terminal = (input: Record<string, unknown>, output: unknown) =>
    text(draw(stepView({
      name: "terminal",
      input,
      output: JSON.stringify(output),
    } as never, ctxOf({}))));
  const done = { state: "idle", commandId: "c1", stdout: "ok\n", stderr: "", exitCode: 0 };
  assertStringIncludes(terminal({ stdin: "ls", computer: "builder" }, done), "builder");
  assertStringIncludes(terminal({ stdin: "ls" }, { ...done, computer: "laptop" }), "laptop");
  assert(
    !draw(stepView({
      name: "terminal",
      input: { stdin: "ls" },
      output: JSON.stringify(done),
    } as never, ctxOf({}))).includes(`class="step-on"`),
    "one computer: nothing said",
  );
  assertStringIncludes(
    terminal({ stdin: "ls", computer: "desktop" }, "desktop is offline: ana can start it again."),
    "no computer",
  );
});
