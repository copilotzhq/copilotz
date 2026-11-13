/**
 * Computers and previews on the web, drawn (as the server would draw them,
 * through React's own renderer): adding a computer as a choice, beside the
 * kinds of computer an app adds (hosted ones, say); a space's computers; a
 * job that serves a port, before and after its preview, and the previews
 * list; and a tool step's computer. The front ends' resources name their
 * Views as computers' pages read them.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Preview } from "../computers/collections/preview.ts";
import type { Computer } from "../computers/collections/computer.ts";
import type { Desk } from "../computers/collections/desk.ts";
import type { Job } from "../computers/shared/workloads.ts";
import type { Reached } from "../../access/spaces/contract.ts";
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
    name: "test",
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

const space: Reached = {
  _id: "s1",
  name: "Acme",
  kind: "shared",
  can: ["read", "write", "manage"],
} as unknown as Reached;
/** A kind of computer an app adds (its `computerKinds` resource): hosted ones, as Compass's. */
const kinds = kindsOf({
  cloud: {
    title: "Cloud computer",
    icon: "server",
    mine: "cloudComputer.mine",
    view: "cloud.computer",
    add: {
      view: "cloud.new",
      title: "Use a cloud computer",
      description: "Ready in seconds, with nothing to install. It sleeps when it isn't " +
        "used, and you pay only while it's awake.",
      heading: "New cloud computer",
      available: "cloudComputer.sizes",
    },
    remove: {
      action: "cloud.destroy",
      label: "Delete this computer",
      title: "Delete {name}?",
      text: "Its disk is deleted.",
      button: "Delete it",
    },
    order: 10,
  },
});

test("adding a computer: a kind the app adds or your own machine, as a choice", () => {
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
  // An app's own action on a job (its `jobActions` resource): publishing it, as Compass's.
  actions: jobActionsOf({ publish: { view: "app.publish", order: 10 } }),
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
