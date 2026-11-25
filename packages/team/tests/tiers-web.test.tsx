/**
 * Tiers on the web: a typical message in cents people compare, efforts and
 * who chose the tier in words; the org's tiers as cards, each kind of work's
 * model, the default marked, and changing them only for who may; the team
 * with each agent's kind and model; a space's default tier; and the credits
 * a tier goes through on Free.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Shown } from "../tiers/mod.ts";
import { OrgAgents, SpendNote } from "../tiers/views/web/org.tsx";
import { SpaceTier } from "../tiers/views/web/space.tsx";
import { Team, type TeamAgent } from "../tiers/views/web/team.tsx";
import {
  bySaid,
  creditsGo,
  effortSaid,
  faster,
  perReply,
  providerSaid,
  tierPriceSaid,
} from "../tiers/views/web/words.ts";
import { test } from "copilotz/testing";

const call = () => Promise.resolve({} as never);

const text = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();

const model = (id: string, name: string, price: number | null, effort?: string) => ({
  id,
  name,
  price,
  ...(effort ? { effort } : {}),
});

/** An org on its plan's Everyday, with Expert on offer. */
const shown = (more: Partial<Shown> = {}): Shown => ({
  tiers: [
    {
      name: "everyday",
      title: "Everyday",
      description: "Quick answers, routine work, volume",
      price: 0.023,
      app: true,
      kinds: [{
        kind: "north",
        model: {
          ...model("a/haiku", "Claude Haiku 5.5", 0.023, "low"),
          fallbacks: [{ id: "chatgpt/luna", name: "GPT-6 Luna" }, {
            id: "openai/luna",
            name: "GPT-6 Luna",
          }],
        },
      }],
    },
    {
      name: "expert",
      title: "Expert",
      description: "Hard problems, decisions that matter",
      price: 0.3,
      app: true,
      kinds: [
        { kind: "north", model: model("a/opus", "Claude Opus 5.5", 0.2, "medium") },
        { kind: "east", model: model("a/sonnet", "Claude Sonnet 5.5", 0.1, "high") },
      ],
    },
  ],
  kinds: [
    { kind: "north", title: "Decides", agents: [{ agent: "north", name: "North", icon: "🧭" }] },
    { kind: "east", title: "Builds", agents: [{ agent: "east", name: "East" }] },
  ],
  removed: [],
  plan: "everyday",
  org: { tier: null, cap: null },
  person: { tier: null },
  now: { tier: "everyday", by: "plan" },
  per: "message",
  reply: { input: 20_000, cached: 16_000, output: 1_000 },
  credits: { plan: "free", title: "Free", amount: 5, every: "once" },
  ...more,
});

const team: TeamAgent[] = [
  { id: "north", name: "North", icon: "🧭", description: "Decides. Then more.", kind: "app" },
  { id: "east", name: "East", kind: "changed" },
  { id: "ledger", name: "Ledger", kind: "org", like: "north" },
  { id: "west", name: "West", kind: "app", off: true },
];

test("prices, efforts, who chose and who runs a model, in words", () => {
  assertEquals(
    [0.0002, 0.0013, 0.039, 0.096, 0.4, 1.2].map(perReply),
    ["under 0.1¢", "0.1¢", "3.9¢", "9.6¢", "40¢", "$1.20"],
  );
  assertEquals([effortSaid("xhigh"), effortSaid("none"), effortSaid()], [
    "extra-high effort",
    "no reasoning",
    undefined,
  ]);
  assertEquals(["thread", "person", "space", "org", "plan"].map((by) => bySaid(by as never)), [
    "chosen for this chat",
    "your default",
    "this space's default",
    "the org's default",
    "your plan's default",
  ]);
  assertEquals([providerSaid("chatgpt/x"), providerSaid("anthropic/x"), providerSaid("groq/x")], [
    "your ChatGPT plan",
    "Anthropic",
    "groq",
  ]);
  assertEquals(creditsGo(shown().credits, 0.023, "message"), "about 220 messages with Free's $5");
  assertEquals(
    creditsGo(
      { plan: "team", title: "Team", amount: 29, every: "month", perSeat: true },
      0.12,
      "message",
    ),
    "about 240 messages a month for each seat on Team",
  );
  assertEquals([faster(0.3, 0.023), faster(0.024, 0.023)], ["13×", undefined]);
});

test("a tier's price for the person: theirs with their plans, nothing on them alone", () => {
  assertEquals(tierPriceSaid({ price: 0.02 }), "2¢", "nothing of theirs: the app's price");
  assertEquals(tierPriceSaid({ price: 0.02, yours: 0.004 }), "0.4¢", "partly on their plans");
  assertEquals(tierPriceSaid({ price: 0.02, yours: 0 }), "on your plans · model $0");
  assertEquals(tierPriceSaid({ price: null }), undefined);
});

test("the org's tiers: the default, each kind's model and fallbacks, and changing them for who may", () => {
  const owner = text(<OrgAgents shown={shown()} team={team} may org="Acme" call={call} />);
  assertStringIncludes(owner, "New chats use Everyday , your plan's default.");
  assertStringIncludes(owner, "Everyday Default");
  assertStringIncludes(owner, "2.3¢ a message");
  assertStringIncludes(owner, "About 220 messages with Free's $5");
  assertStringIncludes(owner, "Decides Claude Haiku 5.5 then GPT-6 Luna");
  assertStringIncludes(owner, "Make it the default");
  assertStringIncludes(owner, "New tier");
  assertStringIncludes(owner, "Members can choose up to");
  assertEquals(owner.includes("owners and admins change these"), false);
  const member = text(<OrgAgents shown={shown()} team={team} may={false} org="Acme" call={call} />);
  assertStringIncludes(member, "Only Acme's owners and admins change these.");
  assertEquals(
    [
      member.includes("Make it the default"),
      member.includes("New tier"),
      member.includes("Members can choose"),
    ],
    [false, false, false],
  );
});

test("a heavier default on Free says how much faster it spends; a plan with no credits says so", () => {
  const expert = text(<SpendNote shown={shown()} tier="expert" />);
  assertStringIncludes(expert, "Expert uses your credits about 13× faster than Everyday.");
  assertStringIncludes(expert, "about 16 messages with Free's $5");
  assertEquals(text(<SpendNote shown={shown()} tier="everyday" />), "");
  const none = text(
    <SpendNote
      shown={shown({ credits: { plan: "free", title: "Free", amount: 0, every: "once" } })}
    />,
  );
  assertStringIncludes(none, "Free gives this org no credits.");
});

test("the team: each agent's kind and model on the default tier; the org's and changed ones marked", () => {
  const owner = text(
    <Team shown={shown()} team={team} may org="Acme" tier="everyday" call={call} />,
  );
  assertStringIncludes(owner, "Every space in Acme starts with these agents.");
  assertStringIncludes(owner, "North @north Decides.");
  assertStringIncludes(owner, "Decides Claude Haiku 5.5, low effort on Everyday");
  assertStringIncludes(owner, "East @east Changed");
  assertStringIncludes(owner, "Ledger @ledger Your org's");
  assertStringIncludes(owner, "Not on your team W West");
  assertStringIncludes(owner, "Add back");
  assertStringIncludes(owner, "Add an agent");
  const member = text(<Team shown={shown()} team={team} may={false} tier="everyday" call={call} />);
  assertStringIncludes(member, "Every space of yours starts with these agents.");
  assertEquals([member.includes("Add an agent"), member.includes("Add back")], [false, false]);
});

test("a space's default tier: as the org's says so; its managers choose any, with each one's price", () => {
  const inherited = text(
    <SpaceTier shown={shown({ space: { tier: null } })} space="s1" manage call={call} />,
  );
  assertStringIncludes(inherited, "New chats here start on Everyday");
  assertStringIncludes(inherited, "As the org's default.");
  assertStringIncludes(inherited, "As the org: Everyday");
  assertStringIncludes(inherited, "Expert · 30¢ a message");
  const own = text(
    <SpaceTier
      shown={shown({ space: { tier: "expert" } })}
      space="s1"
      manage={false}
      call={call}
    />,
  );
  assertStringIncludes(own, "New chats here start on Expert");
  assertStringIncludes(own, "This space's managers can change its default.");
  assertEquals(own.includes("As the org: Everyday"), false);
});
