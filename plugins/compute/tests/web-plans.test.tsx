/**
 * A person's plans on the web: Your plans (drawn as the server would, through React's own
 * renderer), every plan the app has or those its tiers list, grouped and in the person's order;
 * a plan's card in each state, in English and Portuguese; the connect flow in a page, the
 * founder's test end to end (an asleep cloud computer on an old program, its CLI missing: no
 * command shown), an installer that fails (its command only then, with its output and the
 * terminal), and where the plans run when there's no computer; Your computers; the welcome's
 * step; how a sign-in is asked again until it's done; what a CLI says, as it's shown; the
 * palette; and words: nothing English left once the app gives its own.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { PaletteGroup } from "../../../hosts/web/mod.ts";
import { setWords } from "../../../hosts/web/words.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
import { page } from "../../../hosts/web/tests/page.ts";
import type { Account, ProviderShown } from "../../access/accounts/contract.ts";
import type { Computer } from "../computers/collections/computer.ts";
import type { Desk } from "../computers/collections/desk.ts";
import type { Prepared } from "../computers/actions/prepare.ts";
import { INSTALL } from "../computers/shared/install.ts";
import { plansView } from "../computers/views/web/plans.tsx";
import { yoursView } from "../computers/views/web/yours.tsx";
import { plansWelcomeView } from "../computers/views/web/welcome.tsx";
import { plansPaletteView } from "../computers/views/web/plans-palette.ts";
import { ConnectFlow } from "../computers/views/web/connect-flow.tsx";
import { sentence } from "../computers/views/web/plan-card.tsx";
import { SignedInNotice } from "../computers/views/web/plan-shared.tsx";
import { ShareWarning } from "../computers/views/web/desks.tsx";
import { computers as computersPtBR } from "../../../hosts/web/pt-br/computers.ts";
import {
  cardOf,
  type LoginEvent,
  type LoginStep,
  type Machine,
  plainOutput,
  type PlanShown,
  plansOf,
  safeLink,
  shownCode,
  signedPlan,
  signingIn,
} from "../computers/views/web/plan-states.ts";
import { visitorSystem } from "../computers/views/web/platform.ts";
import { computersWeb } from "../computers/web.tsx";
import { test } from "../../../testing/mod.ts";

/** A View's context over fixed reads, by `<collection>.<query>` (a desk's by its computer). */
function ctxOf(
  reads: Record<string, unknown>,
  query: Record<string, string> = {},
  resources: Record<string, unknown> = {},
) {
  return {
    db: {
      collection: (name: string) => ({
        query: (named: string, params?: { computer?: string }) => ({
          status: "ready",
          value:
            reads[params?.computer ? `${name}.${named}.${params.computer}` : `${name}.${named}`],
        }),
        find: () => ({ status: "ready", value: reads[`${name}.find`] }),
      }),
    },
    // The accounts' front end is there: it links Your AI.
    resources: { userMenu: { accounts: { href: "/accounts" } }, ...resources },
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
const signed = (account?: string) => ({
  installed: true,
  signedIn: true,
  at: AT,
  ...(account ? { account } : {}),
});

const mac = computerOf({
  _id: "mac",
  name: "MacBook",
  info: { os: "darwin" },
  engines: {
    claude: signed("ana@example.com"),
    codex: { installed: true, signedIn: false, at: AT },
  },
});
const cloud = computerOf({
  _id: "cloud",
  name: "Cloud computer",
  online: false,
  seen: "2026-11-18T10:00:00.000Z",
  status: { kind: "cloud", state: "asleep" },
  info: { os: "linux" },
  engines: { claude: signed() },
});
const studio = computerOf({
  _id: "studio",
  name: "Studio PC",
  engines: { antigravity: signed() },
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
const CHATGPT: ProviderShown = {
  name: "chatgpt",
  title: "ChatGPT",
  allows: "Agents working for you run on your ChatGPT plan instead of the app's API key.",
  paste: "http://localhost:1455/auth/callback",
  models: ["chatgpt"],
};
const plus: Account = {
  _id: "ana:chatgpt",
  person: "ana",
  provider: "chatgpt",
  status: "connected",
  label: "ana@example.com",
  plan: "Plus",
  connected: AT,
};
const READS = {
  "computer.mine": [mac, cloud, studio],
  "space.reached": SPACES,
  "desk.of.mac": [deskOf("mac", "p")],
  "desk.of.cloud": [deskOf("cloud", "p")],
  "desk.of.studio": [deskOf("studio", "p"), deskOf("studio", "acme")],
  "account.providers": [CHATGPT],
  "account.find": [],
};
/** As the app's tiers list the plans it uses, in the person's order (`planList`). */
const LISTED = [
  {
    name: "claude-plan",
    title: "Claude plan",
    plan: "Claude plan",
    model: "claude-plan/claude-haiku-5-5",
    connected: true,
  },
  {
    name: "chatgpt",
    title: "ChatGPT",
    plan: "ChatGPT plan",
    model: "chatgpt/gpt-6-luna",
    connected: false,
  },
  {
    name: "codex-plan",
    title: "ChatGPT plan, through Codex",
    plan: "ChatGPT plan",
    connected: false,
  },
  { name: "cursor-plan", title: "Cursor plan", plan: "Cursor plan", connected: false },
];
const TIERS = { planList: { query: "modelChoice.harnesses", order: "tiers.harnesses" } };
/** The app keeps cloud computers: the one here wakes. */
const CLOUD = {
  computerKinds: {
    cloud: {
      title: "Cloud computer",
      icon: "server",
      mine: "cloudComputer.mine",
      view: "cloud.computer",
    },
  },
};

const machine = (computer: Computer, shared: Machine["shared"] = []): Machine => ({
  computer,
  name: computer.name ?? computer._id,
  shared,
  ...(computer.status ? { kind: { view: "cloud.computer", icon: "server" } } : {}),
});

test("without tiers: every plan the app has, each on its own card, not connected, each to Connect", () => {
  const shown = text(draw(plansView({}, ctxOf({ ...READS, "computer.mine": [] }))));
  assertStringIncludes(shown, "Your plans");
  for (
    const plan of [
      "ChatGPT",
      "Claude plan",
      "ChatGPT plan, through Codex",
      "Google AI plan, through Antigravity",
      "Grok plan",
    ]
  ) {
    assertStringIncludes(shown, `${plan} Not connected: your agents use the app's models. Connect`);
  }
  assertStringIncludes(shown, "Your plan pays for the AI.");
  // Loading, nothing yet.
  assertStringIncludes(draw(plansView({}, ctxOf({}))), 'aria-busy="true"');
});

test("what pays: their plan for the AI; a cloud computer, where the app has them, while it's awake", () => {
  assertStringIncludes(
    text(draw(plansView({}, ctxOf(READS)))),
    "Your plan pays for the AI. Sign-ins stay on your computers, or sealed on the server",
  );
  assertStringIncludes(
    text(
      draw(plansView({}, ctxOf({ ...READS, "cloudComputer.mine": [{ _id: "cloud" }] }, {}, CLOUD))),
    ),
    "Your plan pays for the AI. A cloud computer you use for it is charged while it's awake. " +
      "Sign-ins stay on your computers",
  );
});

test("with tiers: the plans they list, ways of a plan as one card, in the person's order; the order to change", () => {
  const plans = plansOf(LISTED, [CHATGPT]);
  // Cursor's way in isn't one this front end connects: left out.
  assertEquals(plans.map((p) => [p.plan, p.ways.map((w) => w.provider)]), [
    ["Claude plan", ["claude-plan"]],
    ["ChatGPT plan", ["chatgpt", "codex-plan"]],
  ]);
  assertEquals(plans[1].ways[0], {
    provider: "chatgpt",
    title: "ChatGPT",
    plan: "ChatGPT plan",
    account: "chatgpt",
    model: "chatgpt/gpt-6-luna",
    connected: false,
  });
  const shown = text(draw(plansView(
    {},
    ctxOf(
      {
        ...READS,
        "modelChoice.harnesses": LISTED,
        "account.find": [plus],
        "cloudComputer.mine": [{ _id: "cloud" }],
      },
      {},
      { ...TIERS, ...CLOUD },
    ),
  )));
  assertStringIncludes(
    shown,
    "Claude plan Connected Running on MacBook (online), with Cloud computer ready as backup.",
  );
  assertStringIncludes(
    shown,
    "ChatGPT plan Connected Connected as ana@example.com (Plus), on the server: always ready.",
  );
  assertStringIncludes(
    shown,
    "Use my plans in this order When a model runs on more than one of your plans, your agents " +
      "try them in this order. 1 Claude plan",
  );
  assertStringIncludes(shown, "2 ChatGPT · not connected");
  assertStringIncludes(shown, "3 ChatGPT plan, through Codex · not connected");
});

test("a plan's card, in each state, in English and Portuguese", () => {
  const [claude, chatgpt] = plansOf(LISTED, [CHATGPT]);
  const google: PlanShown = plansOf(undefined, [])[2];
  const cards = (machines: Machine[], accounts: Account[] = []) => ({
    claude: sentence(cardOf(claude, machines, accounts)),
    chatgpt: sentence(cardOf(chatgpt, machines, accounts)),
  });
  const ready = cardOf(claude, [machine(mac), machine(cloud)], []);
  assertEquals(ready.state === "ready" && [ready.on?.name, ready.backup?.name], [
    "MacBook",
    "Cloud computer",
  ]);
  const laptopOff = machine({ ...mac, online: false });
  const cases = () => ({
    backup: cards([machine(mac), machine(cloud)]).claude,
    asleep: cards([machine(cloud)]).claude,
    away: cards([laptopOff]).claude,
    server: cards([], [plus]).chatgpt,
    reconnect: cards([], [{ ...plus, status: "needs_reconnect" }]).chatgpt,
    // Signed in only where others' agents work: not connected, for its person.
    shared: sentence(cardOf(google, [machine(studio, [{ _id: "acme", name: "Acme" }])], [])),
    off: cards([]).claude,
  });
  assertEquals(cases(), {
    backup: "Running on MacBook (online), with Cloud computer ready as backup.",
    asleep: "Running on Cloud computer (asleep: it wakes when your agents need it).",
    away: "Signed in on MacBook, which is off. Your agents use the app's models until it's on.",
    server: "Connected as ana@example.com (Plus), on the server: always ready.",
    reconnect: "ChatGPT needs you to sign in again.",
    shared: "Not connected: your agents use the app's models.",
    off: "Not connected: your agents use the app's models.",
  });
  // At its limit there: since when.
  const limited = cardOf(claude, [
    machine({ ...mac, engines: { claude: { ...signed(), limited: "2026-11-19T14:20:00.000Z" } } }),
  ], []);
  assertEquals(limited.state === "ready" && limited.limited, "2026-11-19T14:20:00.000Z");
  const restore = setWords(computersPtBR);
  try {
    assertEquals(cases(), {
      backup: "Rodando no MacBook (ligado), com o Cloud computer pronto como reserva.",
      asleep: "Rodando no Cloud computer (dormindo: acorda quando seus agentes precisam).",
      away:
        "Conectado no MacBook, que está desligado. Seus agentes usam os modelos do app até ele ligar.",
      server: "Conectado como ana@example.com (Plus), no servidor: sempre pronto.",
      reconnect: "O ChatGPT precisa que você entre de novo.",
      shared: "Não conectado: seus agentes usam os modelos do app.",
      off: "Não conectado: seus agentes usam os modelos do app.",
    });
  } finally {
    restore();
  }
});

/** Lets what's under way go on: calls answered, effects run. */
const settle = (ms = 20) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
/**
 * Types into a field. React here loaded before the page's DOM, so it hears a change as an old
 * browser says it: the field focused, its value set, a key let go.
 */
function typeInto(element: HTMLInputElement, value: string) {
  return act(() => {
    element.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      value,
    );
    // The page's own events (happy-dom's window), not the runtime's.
    // deno-lint-ignore no-window no-window-prefix
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    // deno-lint-ignore no-window
    element.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }));
  });
}

test("the founder's test, in a page: an asleep cloud computer, an old program, its CLI missing; it ends connected, and no command is ever shown", () =>
  page(async (render) => {
    const asked: [string, unknown][] = [];
    const logins: LoginStep[] = [
      { state: "running", output: "Installing Claude Code…\n", signedIn: false },
      {
        state: "running",
        output: "Paste code here if prompted > ",
        signedIn: false,
        url: "https://claude.ai/oauth/authorize?code=true",
      },
    ];
    const call = <R,>(action: string, input?: unknown): Promise<R> => {
      asked.push([action, input]);
      if (action === "computer.prepare") {
        // Woken, restarted on the release (computer.prepare's own), and asked: Claude Code missing.
        return Promise.resolve(
          {
            computer: "cloud",
            online: true,
            shared: false,
            engines: { claude: { installed: false, signedIn: false, at: AT } },
            program: { version: "1.0.0-rc.66", current: true },
          } satisfies Prepared as R,
        );
      }
      if (action === "computer.engine.login") {
        if ((input as { input?: string }).input) {
          return Promise.resolve(
            { state: "done", output: "Signed in.\n", signedIn: true, installed: true } as R,
          );
        }
        return Promise.resolve(
          (logins.shift() ?? {
            state: "running",
            output: "",
            signedIn: false,
            url: "https://claude.ai/oauth/authorize?code=true",
          }) as R,
        );
      }
      if (action === "llm.test") return Promise.resolve({ text: "Ready.", ms: 900 } as R);
      return Promise.reject(new Error(`not here: ${action}`));
    };
    const asleep = machine({ ...cloud, engines: {} });
    const seen: string[] = [];
    const look = () => seen.push(document.body.textContent ?? "");
    await render(
      <ConnectFlow
        plans={plansOf(LISTED, [CHATGPT])}
        picked={["claude-plan"]}
        machines={[asleep]}
        computers={[asleep.computer]}
        accounts={[]}
        kinds={[]}
        onClose={() => {}}
        call={call as never}
      />,
    );
    look();
    // Readied, then signing in: installing first, then the sign-in page, here.
    for (let i = 0; i < 80 && !document.querySelector("input[autocomplete=one-time-code]"); i++) {
      await settle(50);
      look();
    }
    const field = document.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]");
    assert(field, "a field for the code its page gives");
    assertStringIncludes(document.body.textContent!, "Open the sign-in page");
    await typeInto(field, "c0de");
    await act(() => field.form!.requestSubmit());
    for (let i = 0; i < 80 && !document.body.textContent!.includes("It answered"); i++) {
      await settle(50);
      look();
    }
    const shown = document.body.textContent!;
    assertStringIncludes(shown, "Cloud computer is ready");
    // One line for the plan: installed as it signed in, signed in, answering.
    assertStringIncludes(shown, "Claude plan");
    assertStringIncludes(shown, "It answered: “Ready.”");
    assertStringIncludes(shown, "Your agents now run on Claude plan.");
    assertEquals(asked.filter(([action]) => action !== "computer.engine.login"), [
      ["computer.prepare", { computer: "cloud" }],
      ["llm.test", { model: "claude-plan/claude-haiku-5-5" }],
    ]);
    assertEquals(asked.find(([a]) => a === "computer.engine.login")?.[1], {
      computer: "cloud",
      engine: "claude",
      install: true,
    });
    // Never a command to run, nor a terminal to run it in.
    for (const said of seen) {
      assert(!said.includes(INSTALL.claude), "no install command shown");
      assert(!said.toLowerCase().includes("terminal"), "no terminal asked for");
    }
  }));

test("a second plan, from its card, finds the computer ready: one check, then its own sign-in, nothing else", () =>
  page(async (render) => {
    const asked: [string, unknown][] = [];
    const call = <R,>(action: string, input?: unknown): Promise<R> => {
      asked.push([action, input]);
      return Promise.resolve(
        (action === "computer.prepare"
          ? {
            computer: "mac",
            online: true,
            shared: false,
            engines: {
              claude: signed("ana@example.com"),
              codex: { installed: true, signedIn: false, at: AT },
            },
            program: { version: "1.0.0-rc.66", current: true },
          }
          : { state: "done", output: "", signedIn: true, installed: true }) as R,
      );
    };
    await render(
      <ConnectFlow
        plans={plansOf(undefined, [])}
        picked={["codex-plan"]}
        machines={[machine(mac)]}
        computers={[mac]}
        accounts={[]}
        kinds={[]}
        onClose={() => {}}
        call={call as never}
      />,
    );
    for (let i = 0; i < 40 && !document.body.textContent!.includes("Your agents now run"); i++) {
      await settle(25);
    }
    assertStringIncludes(
      document.body.textContent!,
      "Your agents now run on ChatGPT plan, through Codex.",
    );
    // Awake and current: computer.prepare only asks it what its CLIs are; Codex is there.
    assertEquals(asked, [
      ["computer.prepare", { computer: "mac" }],
      ["computer.engine.login", { computer: "mac", engine: "codex" }],
    ]);
  }));

test("the welcome's step connects several plans in one flow, one after another", () =>
  page(async (render) => {
    const asked: string[] = [];
    const call = <R,>(action: string): Promise<R> => {
      asked.push(action);
      return new Promise<R>(() => {});
    };
    await render(<>{plansWelcomeView({}, { ...ctxOf(READS), call } as never)}</>);
    const box = (name: string) =>
      [...document.querySelectorAll("label")].find((l) => l.textContent?.startsWith(name))!
        .querySelector("input")!;
    await act(() => box("Claude plan").click());
    await act(() => box("Google AI plan, through Antigravity").click());
    const go = [...document.querySelectorAll("button")].find((b) =>
      b.textContent === "Connect them"
    )!;
    await act(() => go.click());
    await settle();
    const lines = [...document.querySelectorAll(".flow-line")].map((l) =>
      `${l.querySelector(".flow-line-title")!.textContent} ${l.getAttribute("data-state")}`
    );
    assertEquals(lines, [
      "Getting MacBook ready… active",
      "Claude plan waiting",
      "Google AI plan, through Antigravity waiting",
    ]);
    assertEquals(asked, ["computer.prepare"]);
  }));

test("an installer that fails: then, and only then, its command, with what it said, and the computer's terminal", () =>
  page(async (render) => {
    const call = <R,>(action: string): Promise<R> =>
      action === "computer.prepare"
        ? Promise.resolve({
          computer: "mac",
          online: true,
          shared: false,
          engines: { antigravity: { installed: false, signedIn: false, at: AT } },
          program: { version: "1.0.0-rc.66", current: true },
        } as R)
        : Promise.resolve({
          state: "done",
          output: "curl: (6) Could not resolve host\n",
          signedIn: false,
          installed: false,
        } as R);
    await render(
      <ConnectFlow
        plans={plansOf(undefined, [])}
        picked={["gemini-plan"]}
        machines={[machine(mac)]}
        computers={[mac]}
        accounts={[]}
        kinds={[]}
        onClose={() => {}}
        call={call as never}
      />,
    );
    for (let i = 0; i < 40 && !document.body.textContent!.includes("didn't install"); i++) {
      await settle(25);
    }
    const shown = document.body.textContent!;
    assertStringIncludes(
      shown,
      "Antigravity didn't install on MacBook. What its installer said is below.",
    );
    assertStringIncludes(shown, "Could not resolve host");
    assertStringIncludes(shown, "Or install it from MacBook's terminal, then check again:");
    assertStringIncludes(shown, INSTALL.antigravity);
    const terminal = [...document.querySelectorAll("a")].find((a) =>
      a.textContent === "Open MacBook's terminal"
    );
    assertEquals(terminal?.getAttribute("href"), "/computer/mac");
  }));

test("where the plans run, with no computer: in the cloud, made in a click, recommended; this computer only on a desktop", () =>
  page(async (render) => {
    const made: unknown[] = [];
    const call = <R,>(action: string, input?: unknown): Promise<R> => {
      made.push([action, input]);
      return action === "cloud.create"
        ? Promise.resolve({ computer: "new-cloud" } as R)
        : new Promise<R>(() => {});
    };
    const kinds = [{
      key: "cloud",
      title: "Cloud computer",
      mine: "cloudComputer.mine",
      view: "cloud.computer",
      add: {
        view: "cloud.new",
        title: "Use a cloud computer",
        description: "",
        quick: { action: "cloud.create", input: { size: "small" } },
      },
    }];
    await render(
      <ConnectFlow
        plans={plansOf(undefined, [])}
        picked={["claude-plan"]}
        machines={[]}
        computers={[]}
        accounts={[]}
        kinds={kinds}
        personal="p"
        onClose={() => {}}
        call={call as never}
      />,
    );
    await settle();
    const shown = document.body.textContent!;
    assertStringIncludes(shown, "Where should they run?");
    assertStringIncludes(shown, "In the cloud Recommended");
    assertStringIncludes(shown, "Always ready. It sleeps when your agents aren't working");
    // This computer, only where the browser is a desktop's.
    assertEquals(shown.includes("On this computer"), !!visitorSystem());
    const choice = [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.startsWith("In the cloud"))!;
    await act(() => choice.click());
    await settle();
    assertEquals(made[0], ["cloud.create", { size: "small", in: "p" }]);
    assertEquals(made[1], ["computer.prepare", { computer: "new-cloud" }]);
  }));

test("the welcome's step: the app's plans and None; picking offers to connect them", () => {
  const shown = text(draw(plansWelcomeView({}, ctxOf({ ...READS, "account.find": [plus] }))));
  assertStringIncludes(shown, "ChatGPT Connected");
  assertStringIncludes(shown, "Claude plan");
  assertStringIncludes(shown, "None of these");
  assertStringIncludes(shown, "You can connect them later, in Your AI.");
});

test("your computers: each one's state, the plans it runs, its terminal; one shared says so", () => {
  const markup = draw(yoursView({}, ctxOf(READS)));
  const shown = text(markup);
  assertStringIncludes(shown, "Your computers");
  assertStringIncludes(shown, "MacBook Online · Runs Claude plan Terminal");
  assertStringIncludes(shown, "Cloud computer");
  assertStringIncludes(
    shown,
    "Studio PC Online · Studio PC is shared with others' agents, so plans can't run on it.",
  );
  assertStringIncludes(markup, 'href="/computer/mac"');
});

test("a computer signed in to a plan isn't shared with others' agents until it's signed out: in English and Portuguese", () => {
  assertEquals(signedPlan(mac), "Claude plan");
  assertEquals(signedPlan(computerOf({ _id: "x" })), undefined);
  const notice = () => draw(<SignedInNotice computer="MacBook" plan={signedPlan(mac)!} />);
  assertStringIncludes(
    text(notice()),
    "MacBook is signed in to your Claude plan. Sign out of it first: a computer shared with " +
      "others can't keep plan sign-ins. Your plans",
  );
  assertStringIncludes(notice(), 'href="/accounts"');
  const acme = SPACES[1] as Parameters<typeof ShareWarning>[0]["space"];
  assertStringIncludes(
    text(draw(<ShareWarning space={acme} name="MacBook" />)),
    "Agents in Acme run on MacBook as you: they can read everything you can on it",
  );
  const restore = setWords(computersPtBR);
  try {
    assertStringIncludes(text(notice()), "MacBook está conectado ao seu Plano do Claude.");
  } finally {
    restore();
  }
});

test("a sign-in is asked again until it's done, one call at a time; a code goes with the next; asked to install, only the first says so", async () => {
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
    install: true,
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
  assertEquals(asked[0], { computer: "mac", engine: "claude", install: true });
  assertEquals(asked[1], { computer: "mac", engine: "claude" });
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
  const device = "2. Enter this one-time code (expires in 15 minutes)\n   ABCD-7Q2K\n";
  assertEquals(shownCode(device), "ABCD-7Q2K");
  assertEquals(shownCode("Paste code here if prompted > "), undefined);
});

test("the palette: each plan to connect, or how it stands", () => {
  const groups = plansPaletteView(
    {},
    ctxOf({ ...READS, "account.find": [plus] }),
  ) as PaletteGroup[];
  assertEquals(groups[0].title, "General");
  const items = groups[0].items;
  const chatgpt = items.find((i) => i.key === "plans:connected:ChatGPT");
  assertEquals(
    chatgpt?.description,
    "Connected as ana@example.com (Plus), on the server: always ready.",
  );
  const google = items.find((i) => i.key === "plans:connect:Google AI plan, through Antigravity");
  assertEquals(google?.label, "Connect your Google AI plan, through Antigravity");
  assertEquals(google?.href, "/accounts?connect=Google%20AI%20plan%2C%20through%20Antigravity");
  assertEquals(plansPaletteView({}, ctxOf({})), null);
});

test("the front end adds Your plans (the plans among the accounts) and Your computers to Your AI, its slots and its commands", () => {
  assertEquals(computersWeb.resources?.accountSections, {
    plans: { view: "computer.plans", order: 10, plans: true },
    computers: { view: "computer.yours", order: 20 },
  });
  assertEquals(
    (computersWeb.resources?.palette as Record<string, unknown>).plans,
    { view: "computer.plans.palette", order: 91 },
  );
  for (
    const view of ["computer.plans", "computer.yours", "computer.plans.welcome", "computer.cost"]
  ) {
    assert(computersWeb.views?.[view], view);
  }
});

test("its words are the app's: nothing English left once they're all given", () => {
  // The toolkit's own words (a dialog's Close) are the toolkit's: given too.
  const restore = setWords({ ...pseudoWords("computers"), ...pseudoWords("toolkit") });
  try {
    const tiers = ctxOf(
      { ...READS, "modelChoice.harnesses": LISTED, "account.find": [plus] },
      {},
      TIERS,
    );
    const markup = [
      draw(plansView({}, tiers)),
      draw(plansView({}, ctxOf({ ...READS, "computer.mine": [] }))),
      draw(yoursView({}, ctxOf(READS))),
      draw(plansWelcomeView({}, ctxOf(READS))),
      draw(
        <ConnectFlow
          plans={plansOf(LISTED, [CHATGPT])}
          picked={["claude-plan", "chatgpt"]}
          machines={[machine(mac)]}
          computers={[mac]}
          accounts={[]}
          kinds={[]}
          onClose={() => {}}
          call={() => Promise.resolve({} as never)}
        />,
      ),
    ].join("");
    // What people read: the text, and the attributes they hear or see (not names or classes).
    const read = [
      text(markup),
      ...[...markup.matchAll(/(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]),
    ].join(" ")
      // What the app's tiers and accounts say (the app words them: `text.<English>`), and names.
      .replace(
        /Claude plan|ChatGPT plan, through Codex|ChatGPT plan|ChatGPT|Google AI plan, through Antigravity/g,
        "",
      )
      .replace(/MacBook|Cloud computer|Studio PC|ana@example\.com|Plus|Acme/g, "");
    assertEquals(englishLeft(read, "computers"), []);
    assertStringIncludes(markup, "«computers.plansTitle»");
  } finally {
    restore();
  }
});
