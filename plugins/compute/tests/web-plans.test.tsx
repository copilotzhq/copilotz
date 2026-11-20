/**
 * A person's plans on their own computers, on the web: the section of Connected accounts
 * (drawn as the server would, through React's own renderer) with no computer yet, and with
 * computers in each state (signed in as whom, installed, its CLI missing, offline, not checked,
 * shared with others' agents); the sign-in dialog's choice of computer and what that one still
 * needs; how a sign-in is asked again until it's done; what a CLI says, as it's shown; the
 * palette's commands; and words: nothing English left once the app gives its own.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { PaletteGroup } from "../../../hosts/web/mod.ts";
import { setWords } from "../../../hosts/web/words.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
import type { Computer } from "../computers/collections/computer.ts";
import type { Desk } from "../computers/collections/desk.ts";
import { plansView } from "../computers/views/web/plans.tsx";
import { plansPaletteView } from "../computers/views/web/plans-palette.ts";
import { SignInDialog } from "../computers/views/web/plan-sign-in.tsx";
import {
  asksForCode,
  type LoginEvent,
  type LoginStep,
  type Machine,
  plainOutput,
  planOf,
  ranked,
  safeLink,
  sharedIn,
  shownCode,
  signingIn,
  standingOf,
  straightTo,
} from "../computers/views/web/plans.ts";
import { computersWeb } from "../computers/web.tsx";
import { test } from "../../../testing/mod.ts";

/** A View's context over fixed reads, by `<collection>.<query>` (and a desk's by its computer). */
function ctxOf(reads: Record<string, unknown>, query: Record<string, string> = {}) {
  return {
    db: {
      collection: (name: string) => ({
        query: (named: string, params?: { computer?: string }) => ({
          status: "ready",
          value:
            reads[params?.computer ? `${name}.${named}.${params.computer}` : `${name}.${named}`],
        }),
      }),
    },
    resources: {},
    name: "test",
    viewer: { name: "ana" },
    hints: { query, mode: "full" },
    show: () => null,
    call: () => Promise.resolve({} as never),
    emit: () => Promise.resolve(),
  } as unknown as ViewContext<ReactNode>;
}

const draw = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const AT = "2026-11-19T10:00:00.000Z";
const computerOf = (over: Partial<Computer> & { _id: string }): Computer => ({
  owner: "ana",
  secret: "",
  online: true,
  at: AT,
  seen: AT,
  ...over,
});

const mac = computerOf({
  _id: "mac",
  name: "MacBook Pro",
  engines: {
    claude: {
      installed: true,
      signedIn: true,
      version: "2.0.31",
      account: "ana@example.com",
      at: AT,
    },
    codex: { installed: true, signedIn: false, version: "0.58.0", at: AT },
    antigravity: { installed: false, signedIn: false, at: AT },
  },
});
const thinkpad = computerOf({
  _id: "pad",
  name: "Old ThinkPad",
  online: false,
  seen: "2026-11-18T10:00:00.000Z",
  engines: { claude: { installed: true, signedIn: false, at: AT } },
});
const studio = computerOf({
  _id: "studio",
  name: "studio-linux",
  engines: { claude: { installed: true, signedIn: false, at: AT } },
});
const deskOf = (computer: string, space: string, answers: "asker" | "owner" = "asker"): Desk => ({
  _id: `${computer}-${space}`,
  in: space,
  computer,
  owner: "ana",
  folder: space,
  online: true,
  answers,
  at: AT,
});
const SPACES = [
  { _id: "p", name: "Ana", kind: "personal", can: ["read", "write", "manage"] },
  { _id: "acme", name: "Acme", kind: "shared", can: ["read", "write", "manage"] },
];
const READS = {
  "computer.mine": [mac, thinkpad, studio],
  "space.reached": SPACES,
  "desk.of.mac": [deskOf("mac", "p")],
  "desk.of.pad": [deskOf("pad", "p")],
  "desk.of.studio": [deskOf("studio", "p"), deskOf("studio", "acme")],
};

const machine = (computer: Computer, shared: Machine["shared"] = []): Machine => ({
  computer,
  name: computer.name ?? computer._id,
  shared,
});

test("no computer yet: what plans need, every plan named, and connecting one first", () => {
  const markup = draw(plansView({}, ctxOf({ "computer.mine": [], "space.reached": SPACES })));
  const shown = text(markup);
  assertStringIncludes(shown, "Plans on your computers");
  assertStringIncludes(shown, "instead of an API key");
  assertStringIncludes(shown, "Connect a computer of yours first");
  for (
    const title of [
      "Claude plan",
      "ChatGPT plan, through Codex",
      "Google AI plan, through Antigravity",
    ]
  ) {
    assertStringIncludes(shown, title);
  }
  assertStringIncludes(shown, "Connect a computer");
  assertStringIncludes(shown, "this app never sees it");
  assert(!/>Sign in</.test(markup), "nothing to sign in on yet");
});

test("a card per plan, each computer as it stands: signed in as whom, installed, missing, offline, shared", () => {
  const markup = draw(plansView({}, ctxOf(READS)));
  const shown = text(markup);
  // Claude: signed in on the Mac, as whom, with its version; the ThinkPad offline.
  assertStringIncludes(shown, "Signed in as ana@example.com");
  assertStringIncludes(shown, "version 2.0.31");
  assertStringIncludes(shown, "Installed, not signed in");
  assertStringIncludes(shown, "Offline");
  // Codex: installed on the Mac, not signed in: the card's Sign in goes straight there.
  assertStringIncludes(shown, "ChatGPT plan, through Codex");
  // Antigravity: missing on the Mac, its install offered.
  assertStringIncludes(shown, "Antigravity isn't installed");
  assertStringIncludes(shown, "How to install");
  // Shared into Acme: said once, over the cards, with how to change it; not a line of each card.
  assertStringIncludes(shown, "studio-linux is shared with others' agents in Acme");
  assertStringIncludes(shown, "How to use it");
  assertEquals(shown.split("studio-linux").length - 1, 1);
  // Signed in once, Claude says so; the others offer Sign in.
  assertEquals((markup.match(/copilotz-badge/g) ?? []).length >= 1, true);
  assertEquals((shown.match(/Sign in(?! again| on| as)/g) ?? []).length, 2);
  assertStringIncludes(shown, "Check again");
  assertStringIncludes(shown, "Connect a computer");
});

test("loading, it says nothing yet", () => {
  const ctx = ctxOf({});
  const markup = draw(plansView({}, ctx));
  assertStringIncludes(markup, 'aria-busy="true"');
  assert(!text(markup).includes("Sign in"));
});

test("how a computer stands for a plan, and where a sign-in goes first", () => {
  const all = [machine(mac), machine(thinkpad), machine(studio, [{ _id: "acme", name: "Acme" }])];
  assertEquals(standingOf(all[0], "claude"), {
    state: "signedIn",
    account: "ana@example.com",
    version: "2.0.31",
    at: AT,
  });
  assertEquals(standingOf(all[0], "codex").state, "installed");
  assertEquals(standingOf(all[0], "antigravity").state, "missing");
  assertEquals(standingOf(all[1], "codex").state, "unchecked");
  assertEquals(standingOf(all[2], "claude").state, "shared");
  // On, its CLI there and not signed in, first; shared last.
  assertEquals(ranked(all, "codex").map((m) => m.computer._id), ["mac", "pad", "studio"]);
  // The only computer a sign-in can start on goes straight; none, or a choice, opens the dialog.
  assertEquals(straightTo(all, "codex")?.computer._id, "mac");
  assertEquals(straightTo(all, "antigravity"), undefined);
  assertEquals(straightTo([...all, machine({ ...mac, _id: "mac2" })], "codex"), undefined);
  // A cloud computer asleep can start (it wakes); an own one offline can't.
  const asleep = { ...machine({ ...thinkpad, _id: "cloud" }), kind: { view: "cloud.state" } };
  assertEquals(straightTo([machine(thinkpad), asleep], "claude")?.computer._id, "cloud");
  // Shared where others' agents answer to themselves; a Personal space, or asking the owner, isn't.
  assertEquals(sharedIn([deskOf("s", "p"), deskOf("s", "acme")], SPACES), [
    { _id: "acme", name: "Acme" },
  ]);
  assertEquals(sharedIn([deskOf("s", "acme", "owner")], SPACES), []);
  assertEquals(planOf("codex")?.install, "npm i -g @openai/codex");
  assertEquals(planOf("nope"), undefined);
});

test("the sign-in dialog: which computer, and what the one chosen still needs", () => {
  const all = [machine(mac), machine(thinkpad), machine(studio, [{ _id: "acme", name: "Acme" }])];
  const dialog = (engine: "claude" | "antigravity") =>
    draw(
      <SignInDialog
        plan={planOf(engine)!}
        machines={all}
        open
        onClose={() => {}}
        check={() => Promise.resolve()}
        call={() => Promise.resolve({} as never)}
      />,
    );
  const missing = text(dialog("antigravity"));
  assertStringIncludes(missing, "Sign in to your Google AI plan");
  assertStringIncludes(missing, "On which computer?");
  assertStringIncludes(missing, "Antigravity isn't installed on MacBook Pro yet");
  assertStringIncludes(missing, "curl -fsSL https://antigravity.google/cli/install.sh | bash");
  assertStringIncludes(missing, "your own use of Antigravity on that computer stays as it is");
  // The shared one is there, and can't be chosen.
  const markup = dialog("claude");
  assertStringIncludes(text(markup), "Shared with others' agents");
  assertEquals((markup.match(/disabled=""/g) ?? []).length >= 1, true);
  assertStringIncludes(text(markup), "Signed in as ana@example.com");
});

test("a sign-in is asked again until it's done, one call at a time; a code goes with the next", async () => {
  const asked: Record<string, unknown>[] = [];
  const answers: LoginStep[] = [
    { state: "running", output: "Starting…\n", signedIn: false },
    {
      state: "running",
      output: "Visit https://example.com/s\n",
      signedIn: false,
      url: "https://example.com/s",
    },
    { state: "running", output: "", signedIn: false },
    { state: "done", output: "Done.\n", signedIn: true },
  ];
  const events: LoginEvent[] = [];
  const { promise: over, resolve } = Promise.withResolvers<void>();
  const session = signingIn({
    computer: "mac",
    engine: "claude",
    every: 5,
    call: <R,>(_action: string, input?: unknown) => {
      asked.push(input as Record<string, unknown>);
      return Promise.resolve(answers.shift() as R);
    },
    on: (event) => {
      events.push(event);
      if ("step" in event && event.step.url && !asked.some((a) => a.input)) session.send("C0DE");
      if ("error" in event || event.step.state === "done") resolve();
    },
  });
  await over;
  assertEquals(asked.length, 4);
  assertEquals(asked[0], { computer: "mac", engine: "claude" });
  assertEquals(asked[2].input, "C0DE");
  assertEquals(events.length, 4);
  // Done, it stops: stopping then tells the computer nothing.
  session.stop();
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(asked.length, 4);

  // Stopped under way, the computer is told; a failure ends it with why.
  const told: Record<string, unknown>[] = [];
  const stopped = signingIn({
    computer: "mac",
    engine: "codex",
    every: 1000,
    call: <R,>(_action: string, input?: unknown) => {
      told.push(input as Record<string, unknown>);
      return Promise.resolve({ state: "running", output: "", signedIn: false } as R);
    },
    on: () => {},
  });
  await new Promise((r) => setTimeout(r, 10));
  stopped.stop();
  assertEquals(told.at(-1), { computer: "mac", engine: "codex", stop: true });
  const failed = await new Promise<LoginEvent>((done) => {
    signingIn({
      computer: "pad",
      engine: "claude",
      call: () => Promise.reject(new Error("The computer is offline.")),
      on: done,
    });
  });
  assert("error" in failed);
});

test("what a CLI says, as it's shown: no escapes, safe links, a code it shows or asks for", () => {
  assertEquals(
    plainOutput(
      "\x1b[2mStarting\x1b[0m…\r\nOpening 10%\rOpening 100%\n\n\n\nDone \x1b]0;title\x07",
    ),
    "Starting…\nOpening 100%\n\nDone",
  );
  assertEquals(safeLink("https://claude.ai/oauth?x=1"), "https://claude.ai/oauth?x=1");
  assertEquals(safeLink("javascript:alert(1)"), undefined);
  assertEquals(safeLink("file:///etc/passwd"), undefined);
  assertEquals(safeLink(undefined), undefined);
  // A device's sign-in: a code to type on the page, on the next line.
  const device = "2. Enter this one-time code (expires in 15 minutes)\n   ABCD-7Q2K\n";
  assertEquals(shownCode(device), "ABCD-7Q2K");
  assertEquals(asksForCode(device), false);
  // A code to paste back.
  assertEquals(asksForCode("Paste code here if prompted > "), true);
  assertEquals(shownCode("Paste code here if prompted > "), undefined);
  assertEquals(asksForCode("Opening your browser to sign in…"), false);
});

test("the palette: plans, signing each in, and where one is signed in", () => {
  const groups = plansPaletteView({}, ctxOf(READS)) as PaletteGroup[];
  assertEquals(groups[0].title, "General");
  const items = groups[0].items;
  assertEquals(items[0], {
    key: "plans:open",
    label: "Plans on your computers",
    icon: "sparkles",
    keywords: items[0].keywords,
    href: "/accounts",
  });
  const claude = items.find((i) => i.key === "plans:signed:claude");
  assertEquals(claude?.description, "Signed in on MacBook Pro");
  const codex = items.find((i) => i.key === "plans:signin:codex");
  assertEquals(codex?.label, "Sign in to your ChatGPT plan");
  assertEquals(codex?.href, "/accounts?signin=codex");
  assertEquals(plansPaletteView({}, ctxOf({})), null);
});

test("the front end adds the section to Connected accounts, and its command to the palette", () => {
  assertEquals(computersWeb.resources?.accountSections, {
    plans: { view: "computer.plans", order: 10 },
  });
  assertEquals(
    (computersWeb.resources?.palette as Record<string, unknown>).plans,
    { view: "computer.plans.palette", order: 91 },
  );
  assert(computersWeb.views?.["computer.plans"]);
  assert(computersWeb.views?.["computer.plans.palette"]);
});

test("its words are the app's: nothing English left once they're all given", () => {
  // The toolkit's own words (a dialog's Close) are the toolkit's: given too.
  const restore = setWords({ ...pseudoWords("computers"), ...pseudoWords("toolkit") });
  try {
    const all = [machine(mac), machine(thinkpad), machine(studio, [{ _id: "acme", name: "Acme" }])];
    const markup = [
      draw(plansView({}, ctxOf(READS))),
      draw(plansView({}, ctxOf({ "computer.mine": [], "space.reached": SPACES }))),
      draw(
        <SignInDialog
          plan={planOf("antigravity")!}
          machines={all}
          open
          onClose={() => {}}
          check={() => Promise.resolve()}
          call={() => Promise.resolve({} as never)}
        />,
      ),
    ].join("");
    // What people read: the text, and the attributes they hear or see (not names or classes).
    const read = [
      text(markup),
      ...[...markup.matchAll(/(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]),
    ].join(" ");
    assertEquals(englishLeft(read, "computers"), []);
    assertStringIncludes(markup, "«computers.plansTitle»");
  } finally {
    restore();
  }
});
