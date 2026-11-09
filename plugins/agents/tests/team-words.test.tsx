/**
 * Team's web front end says only the app's words: with every word replaced nothing English
 * shows, with none replaced the English reads as before, and a second language fills blanks and
 * picks plurals.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setWords } from "../../../hosts/web/mod.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { OfferedModel, OfferedProvider } from "../../models/contract.ts";
import type { Agent } from "../chat/contract.ts";
import { AgentFields } from "../team/views/web/agent-fields.tsx";
import { KnownAgents } from "../team/views/web/agent-known.tsx";
import { NewAgent } from "../team/views/web/agent-new.tsx";
import { agentPaletteView } from "../team/views/web/agent-palette.tsx";
import { agentAddView } from "../team/views/web/agent-add.tsx";
import { deleteStep } from "../team/views/web/agent-steps.tsx";
import { agentView } from "../team/views/web/agent.tsx";
import { listed } from "../team/views/web/agents.ts";
import { ModelRow, ProviderKey, Providers, Results } from "../team/views/web/model-picker.tsx";
import type { Place } from "../team/views/web/places.ts";
import { test } from "../../../testing/mod.ts";

const call = () => Promise.resolve({} as never);

const home: Place = { _id: "s1", name: "Acme", kind: "space", can: ["manage"], agent: "maya" };
const personal: Place = { _id: "p1", name: "Ana", kind: "personal", can: ["manage"] };
const places = [home, personal];

const maya: Agent = {
  name: "Nora",
  icon: "🦉",
  description: "Plans trips",
  instructions: "Guides trips.",
  model: "openai/gpt-x",
  tools: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
  in: "s1",
} as unknown as Agent;
const helper = { name: "Helper", instructions: "Help.", model: "openai/gpt-x" } as unknown as Agent;
const known: Record<string, Agent> = { maya, helper };

const options = {
  tools: "abcdefghij".split("").map((name) => ({ name, description: `Does ${name}` })),
  models: ["openai/gpt-x"],
};

const provider = (more: Partial<OfferedProvider>): OfferedProvider => ({
  id: "acme-ai",
  name: "Acme AI",
  models: 3,
  ready: true,
  keyed: true,
  ...more,
});
const model = (more: Partial<OfferedModel>): OfferedModel => ({
  id: "acme-ai/one",
  provider: "acme-ai",
  from: "Acme AI",
  name: "One",
  ready: true,
  ...more,
});

/** A view's context, answering the reads the team views make. */
const context = (hints: Record<string, unknown> = {}) =>
  ({
    hints,
    call,
    resources: {},
    viewer: { name: "ana" },
    db: {
      collection: (name: string) => ({
        find: () => ({
          value: name === "member"
            ? [{ _id: "m1", space: "s1", member: "agent:maya", role: "editor" }, {
              _id: "m2",
              space: "p1",
              member: "agent:maya",
              role: "viewer",
            }]
            : [],
        }),
        query: (query: string) => ({
          value: query === "reached"
            ? places
            : query === "known"
            ? known
            : query === "options"
            ? options
            : query === "agents"
            ? { here: ["maya"], default: ["maya"], agents: { maya } }
            : {},
        }),
      }),
    },
  }) as unknown as ViewContext<ReactNode>;

/** A step or palette as the words it holds: what's said, not the data keys around it. */
const said = (value: unknown) =>
  JSON.stringify(value, (key, v) => {
    if (["member", "kind", "key", "icon", "tone", "href", "role"].includes(key)) return undefined;
    // A step's items are made when it opens: open it.
    return v && typeof v.items === "function" ? { ...v, items: v.items("") } : v;
  });

/** Markup without icons, class names and links (`agent-seat-personal`, `/agent/maya` are code, not words anyone reads). */
const html = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<svg[\s\S]*?<\/svg>/g, "").replace(
    / (class|id|for|href|aria-labelledby|aria-controls|aria-describedby|data-[a-z-]+)="[^"]*"/g,
    "",
  );

function everything(): string[] {
  return [
    html(agentView({ _id: "maya" }, context({ in: "s1" }))),
    html(agentView({ _id: "maya" }, context({ in: "s1", query: { edit: "1" } }))),
    html(agentView({ _id: "nobody" }, context())),
    html(agentView({ _id: "helper" }, context())),
    html(agentAddView({ _id: "s1" }, context())),
    html(agentAddView({ _id: "s1" }, context({ mode: "new", from: "helper" }))),
    html(agentAddView({ _id: "nowhere" }, context())),
    html(
      <KnownAgents
        space={home}
        agents={Object.entries(known)}
        places={places}
        call={call}
        onNew={() => {}}
      />,
    ),
    html(
      <KnownAgents space={home} agents={[]} places={places} call={call} onNew={() => {}} />,
    ),
    html(
      <NewAgent space={home} known={known} options={options} call={call} onBack={() => {}} />,
    ),
    html(
      <AgentFields
        value={{
          name: "Ana",
          icon: "",
          description: "Plans trips",
          instructions: "",
          model: "openai/gpt-x",
          tools: ["a"],
        }}
        onChange={() => {}}
        options={options}
        handle="ana"
        call={call}
      />,
    ),
    html(
      <Providers
        listing={{
          providers: [provider({ hint: "…1a2b" }), provider({ id: "x", ready: false, models: 1 })],
          set: true,
        }}
        onProvider={() => {}}
      />,
    ),
    html(
      <Results
        found={{
          providers: [provider({})],
          models: [
            model({
              context: 200_000,
              input: ["image", "pdf"],
              reasons: true,
              price: { input: 3, output: 15 },
            }),
            model({ id: "b", ready: false }),
            model({ id: "c", price: { input: 0, output: 0 } }),
            model({ id: "d", price: { input: 1, output: 2 }, ownKey: true }),
          ],
        }}
        value="acme-ai/one"
        onProvider={() => {}}
        onChoose={() => {}}
      />,
    ),
    html(
      <Results
        found={{ providers: [], models: [] }}
        value=""
        onProvider={() => {}}
        onChoose={() => {}}
      />,
    ),
    html(<ProviderKey provider={provider({ ready: false })} may call={call} onChange={() => {}} />),
    html(
      <ProviderKey provider={provider({ hint: "…1a2b" })} may call={call} onChange={() => {}} />,
    ),
    html(
      <ProviderKey
        provider={provider({ ready: false })}
        may={false}
        call={call}
        onChange={() => {}}
      />,
    ),
    html(
      <ModelRow model={model({ price: { input: 3, output: 15 } })} value="" onChoose={() => {}} />,
    ),
    said(agentPaletteView(null, context({ in: "s1", page: { kind: "agent", id: "maya" } }))),
    said(agentPaletteView(null, context({ in: "s1", search: "ma" }))),
    said(deleteStep({ agent: "maya", name: "Maya", call, after: () => {} })),
  ];
}

test("with every word replaced, team shows no English of its own", () => {
  // The roles an agent works in are spaces' words: they are replaced too.
  const restore = setWords({ ...pseudoWords("team"), ...pseudoWords("spaces") });
  try {
    const all = everything();
    all.forEach((markup, i) =>
      assertEquals(
        englishLeft(markup, "team"),
        [],
        `output ${i}: ${markup.replace(/<style[\s\S]*?<\/style>/g, "").slice(0, 1500)}`,
      )
    );
    const page = all.join("\n");
    for (
      const key of [
        "noSuchAgent",
        "worksIn",
        "createNewAgent",
        "fieldName",
        "readyToUse",
        "paletteThisAgent",
        "deleteStepNote",
      ]
    ) {
      assertStringIncludes(page, `«team.${key}»`);
    }
  } finally {
    restore();
  }
});

test("with none replaced, the English reads as before", () => {
  const page = html(agentView({ _id: "maya" }, context({ in: "s1" })));
  assertStringIncludes(page, "Made in Acme");
  assertStringIncludes(page, "Answers new chats here");
  assertStringIncludes(page, "Model and tools");
  assertStringIncludes(page, "Show all 10");
  assertStringIncludes(page, "Ask Nora");
  const form = html(<NewAgent space={home} known={known} options={options} call={call} />);
  assertStringIncludes(form, "What should it do?");
  assertStringIncludes(form, "Works in Acme as");
  assertStringIncludes(form, "Create agent");
  assertEquals(listed(["a", "b", "c"]), "a, b and c");
  const models = html(
    <Providers
      listing={{ providers: [provider({ models: 1 })], set: false }}
      onProvider={() => {}}
    />,
  );
  assertStringIncludes(models, "1 model");
  assertStringIncludes(
    html(
      <ModelRow
        model={model({ context: 200_000, price: { input: 3, output: 15 } })}
        value=""
        onChoose={() => {}}
      />,
    ),
    "200K context",
  );
  assertStringIncludes(
    html(
      <ModelRow model={model({ price: { input: 3, output: 15 } })} value="" onChoose={() => {}} />,
    ),
    "$3 in · $15 out per 1M tokens",
  );
});

test("in another language, blanks and plurals follow that language", () => {
  const restore = setWords({
    "team.providerModels": { one: "{count} modelo", other: "{count} modelos" },
    "team.askAgent": "Perguntar a {name}",
    "team.worksNowNames": {
      one: "{names} trabalha em {place} agora.",
      other: "{names} trabalham em {place} agora.",
    },
    "team.listEnd": "{rest} e {last}",
  });
  try {
    const providers = [provider({ models: 1 }), provider({ id: "y", models: 2 })];
    const markup = html(<Providers listing={{ providers, set: false }} onProvider={() => {}} />);
    assertStringIncludes(markup, "1 modelo<");
    assertStringIncludes(markup, "2 modelos");
    assertStringIncludes(
      html(agentView({ _id: "maya" }, context({ in: "s1" }))),
      "Perguntar a Nora",
    );
    assertEquals(listed(["a", "b", "c"]), "a, b e c");
  } finally {
    restore();
  }
});
