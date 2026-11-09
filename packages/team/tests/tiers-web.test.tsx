/**
 * Tiers on the web: a typical reply in cents people compare, efforts and
 * where each model comes from in words; the org's tiers as cards, the one in
 * use marked with who chose it, and choosing only for who may; Customize
 * and the way back; a space's tier and each agent's line, with Change only
 * for its managers.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentNow, Shown } from "../tiers/mod.ts";
import { OrgModels } from "../tiers/views/web/org.tsx";
import { AgentLine, SpaceTier } from "../tiers/views/web/space.tsx";
import {
  chosenSaid,
  effortSaid,
  orgFromSaid,
  perReply,
  spaceFromSaid,
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
      price: 0.0013,
      agents: [{ agent: "north", model: model("a/haiku", "Claude Haiku 5.5", 0.0013) }],
    },
    {
      name: "expert",
      title: "Expert",
      description: "Hard problems, decisions that matter",
      price: 0.039,
      agents: [
        { agent: "north", model: model("a/opus", "Claude Opus 5.5", 0.039, "medium") },
        { agent: "east", model: model("a/sonnet", "Claude Sonnet 5.5", 0.02, "high") },
      ],
    },
  ],
  agents: [{ agent: "north", name: "North", icon: "🧭" }, { agent: "east", name: "East" }],
  plan: "everyday",
  org: { tier: null, custom: {} },
  now: {
    tier: { name: "everyday", by: "plan" },
    agents: {
      north: {
        model: model("a/haiku", "Claude Haiku 5.5", 0.0013),
        from: { by: "plan", tier: "everyday", title: "Everyday" },
      },
      east: { model: model("a/own", "GPT-6 Luna", 0.001), from: { by: "app" } },
    },
  },
  reply: { input: 20_000, cached: 16_000, output: 1_000 },
  ...more,
});

test("a typical reply in cents people compare, and how hard a model thinks, in words", () => {
  assertEquals(
    [0.0002, 0.0013, 0.039, 0.096, 0.4, 1.2].map(perReply),
    ["under 0.1¢", "0.1¢", "3.9¢", "9.6¢", "40¢", "$1.20"],
  );
  assertEquals([perReply(null), perReply(undefined)], [undefined, undefined]);
  assertEquals([effortSaid("xhigh"), effortSaid("none"), effortSaid()], [
    "extra-high effort",
    "no reasoning",
    undefined,
  ]);
});

test("where a model comes from: on the org's page, and in a space", () => {
  const plan = { by: "plan", tier: "everyday", title: "Everyday" } as const;
  const org = { by: "org", tier: "expert", title: "Expert" } as const;
  assertEquals(orgFromSaid(plan), "Everyday, your plan's default");
  assertEquals(orgFromSaid(org), "Expert, chosen by your org");
  assertEquals(orgFromSaid({ by: "org", custom: true }), "picked by your org");
  assertEquals(orgFromSaid({ by: "app" }), "its own model");
  assertEquals(spaceFromSaid(org), "the org's Expert");
  assertEquals(spaceFromSaid(plan), "the plan's Everyday");
  assertEquals(
    spaceFromSaid({ by: "space", tier: "expert", title: "Expert" }),
    "this space's Expert",
  );
  assertEquals(spaceFromSaid({ by: "space", custom: true }), "picked for this space");
  assertEquals(spaceFromSaid({ by: "org", custom: true }), "the org's pick");
  assertEquals([chosenSaid("plan"), chosenSaid("org")], [
    "Your plan's default",
    "Chosen by your org",
  ]);
});

test("the org's tiers: what's in use and why, each with its price and models; choosing for who may", () => {
  const owner = text(<OrgModels shown={shown()} may org="Acme" call={call} />);
  assertStringIncludes(owner, "Your agents use Everyday , your plan's default.");
  assertStringIncludes(owner, "Everyday Your plan's default");
  assertStringIncludes(owner, "0.1¢ a typical reply");
  assertStringIncludes(owner, "3.9¢ a typical reply");
  assertStringIncludes(owner, "🧭 North Claude Opus 5.5 medium effort");
  assertStringIncludes(owner, "In use");
  assertStringIncludes(owner, "Use Expert");
  assertStringIncludes(owner, "Customize");
  assertEquals(owner.includes("owners and admins change"), false);
  // Someone who doesn't run it reads it all, and who changes it; nothing to press.
  const member = text(<OrgModels shown={shown()} may={false} org="Acme" call={call} />);
  assertStringIncludes(member, "Only Acme's owners and admins change these.");
  assertEquals([member.includes("Use Expert"), member.includes("Customize")], [false, false]);
});

test("chosen by the org: marked so, with the way back to the plan's; a pick says so, and how back", () => {
  const chosen = shown({
    org: { tier: "expert", custom: { east: model("a/fable", "Claude Fable 5.1", 0.12) } },
    now: {
      tier: { name: "expert", by: "org" },
      agents: {
        north: {
          model: model("a/opus", "Claude Opus 5.5", 0.039, "medium"),
          from: { by: "org", tier: "expert", title: "Expert" },
        },
        east: {
          model: model("a/fable", "Claude Fable 5.1", 0.12),
          from: { by: "org", custom: true, tier: "expert" },
        },
      },
    },
  });
  const page = text(<OrgModels shown={chosen} may org="Acme" call={call} />);
  assertStringIncludes(page, "Your agents use Expert , chosen by your org.");
  assertStringIncludes(page, "Back to your plan's default");
  assertStringIncludes(page, "Expert Chosen by your org");
  assertStringIncludes(page, "Everyday Plan default");
  assertStringIncludes(page, "One agent has a model picked by your org; Expert's stays behind it");
  assertStringIncludes(page, "Back to Expert");
  assertStringIncludes(page, "Claude Fable 5.1 · picked by your org");
  assertStringIncludes(page, "Claude Opus 5.5 , medium effort · Expert, chosen by your org");
});

test("a space's tier: inherited says so; its managers choose any, with each one's price", () => {
  const here = shown({ space: { tier: null, custom: {} } });
  const managing = text(<SpaceTier shown={here} space="s1" manage call={call} />);
  assertStringIncludes(managing, "Models: Everyday");
  assertStringIncludes(managing, "Your plan's default, as the org hasn't chosen.");
  assertStringIncludes(managing, "As the org: Everyday");
  assertStringIncludes(managing, "Expert · 3.9¢ a reply");
  const reading = text(<SpaceTier shown={here} space="s1" manage={false} call={call} />);
  assertStringIncludes(reading, "This space's managers can change it.");
  const own = shown({
    space: { tier: "expert", custom: {} },
    now: { ...shown().now, tier: { name: "expert", by: "space" } },
  });
  assertStringIncludes(
    text(<SpaceTier shown={own} space="s1" manage call={call} />),
    "Models: Expert Chosen for this space. The org's is Everyday.",
  );
});

test("an agent's line in a space: its model and where from; Change and the way back for managers", () => {
  const now: AgentNow = {
    model: model("a/haiku", "Claude Haiku 5.5", 0.0013),
    from: { by: "org", tier: "everyday", title: "Everyday" },
  };
  assertEquals(
    text(<AgentLine now={now} agent="north" space="s1" manage={false} call={call} />),
    "Claude Haiku 5.5 · the org's Everyday",
  );
  const picked = {
    model: model("a/opus", "Claude Opus 5.5", 0.039),
    from: { by: "space", custom: true, tier: "everyday", title: "Everyday" } as AgentNow["from"],
    without: now,
  };
  const line = text(<AgentLine now={picked} agent="north" space="s1" manage call={call} />);
  assertStringIncludes(line, "Claude Opus 5.5 · picked for this space");
  assertStringIncludes(line, "Back to Claude Haiku 5.5");
});
