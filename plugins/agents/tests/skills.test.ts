/**
 * Skills: know-how agents read when they need it. The app's (its `skills`
 * resource) and a space's (made by its managers) are listed in each turn's
 * system text by name and purpose, the same text until a skill changes;
 * `read_skill` reads one, or a file of it; an agent definition names the
 * skills it gets. A space's skills reach only its own conversations, and
 * only its managers change them. Without skills, nothing changes for chat.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Prompt } from "../chat/mod.ts";
import { planning, type ShownSkill, skills } from "../skills/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { env, tempFile, temporary, test } from "../../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `k_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";
const refused = (promise: Promise<unknown>) =>
  promise.then(() => "done", (error) => (error as { code?: string }).code ?? "failed");

/** What `read_skill` answered, in order. */
let outputs: string[] = [];

/** "read <name> [file]" calls read_skill; then it says what it read. */
const script: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      outputs.push(text(last));
      yield { type: "text", text: "read it" };
      return;
    }
    const said = messages.filter((m) => !text(m).startsWith("<context")).at(-1)!;
    const m = text(said).match(/read (\S+)(?: (\S+))?$/);
    if (m) {
      yield {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "read_skill",
          input: { name: m[1], ...(m[2] ? { file: m[2] } : {}) },
        },
      };
    } else yield { type: "text", text: "ok" };
  },
};

const weekly = {
  description: "Write the weekly report: what shipped, what's next, what's blocked.",
  instructions: "# Weekly report\n\nThree sections, short bullets.",
  files: { "examples/good.md": "- Shipped: search" },
};

async function start(make: () => Store | Promise<Store>, declared: Record<string, unknown> = {}) {
  outputs = [];
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { s: { adapter: "s" } },
      skills: declared,
      agents: {
        lead: { instructions: "I lead.", model: "s/one", default: true },
        focused: { instructions: "I focus.", model: "s/one", skills: ["planning"] },
        plain: { instructions: "I talk.", model: "s/one", skills: [] },
      },
    },
    adapters: { llm: { s: script } },
  });
  return await createRuntime({
    store: await make(),
    plugins: [models, chat, ...access, skills, app],
  });
}

type Rt = Awaited<ReturnType<typeof start>>;

/** A new chat in `space`, as `actor`; its thread once the agents are done. */
async function say(rt: Rt, actor: Actor, space: string, said: string, thread?: string) {
  const sent = await rt.call<{ thread: string }>(
    "chat.send",
    thread ? { thread, text: said } : { text: said, in: space },
    { actor },
  );
  await rt.idle();
  return sent.thread;
}

const prompt = (rt: Rt, thread: string, agent: string) =>
  rt.query<Prompt>("thread.prompt", { thread, agent }, { actor: ana });

/** The skills section of an agent's system text, if it has one. */
const listed = (p: Prompt) => p.system.find((s) => s.includes('<context name="skills">'));

test("the app's skills: listed by name and purpose, read on demand, as each agent may", async () => {
  const rt = await start(memoryStore, { weekly, planning });
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const thread = await say(rt, ana, space, "hello");
    const lead = await prompt(rt, thread, "lead");
    const section = listed(lead)!;
    // Both, by name: planning before weekly, each on one line, after a short guide.
    assertStringIncludes(section, "read_skill");
    assert(
      section.indexOf("- planning: Plan work") < section.indexOf("- weekly: Write the weekly"),
    );
    assert(!section.includes("Three sections"), "instructions come only when read");
    assert(lead.tools.some((t) => t.name === "read_skill"));
    // Focused gets only the one it names; plain gets none, nor the tool.
    const focused = listed(await prompt(rt, thread, "focused"))!;
    assertStringIncludes(focused, "- planning:");
    assert(!focused.includes("weekly"));
    const plain = await prompt(rt, thread, "plain");
    assertEquals(listed(plain), undefined);
    assert(!plain.tools.some((t) => t.name === "read_skill"));

    // Reading one: its instructions, with its files; then a file; then what isn't there.
    await say(rt, ana, space, "read weekly", thread);
    assertStringIncludes(outputs[0], "The weekly skill. Follow it");
    assertStringIncludes(outputs[0], "Three sections, short bullets.");
    assertStringIncludes(outputs[0], "examples/good.md (17 characters)");
    await say(rt, ana, space, "read weekly examples/good.md", thread);
    assertEquals(outputs[1], "weekly/examples/good.md:\n\n- Shipped: search");
    await say(rt, ana, space, "read planning templates.md", thread);
    assertStringIncludes(outputs[2], "## Milestone");
    await say(rt, ana, space, "read weekly nope.md", thread);
    assertEquals(outputs[3], '"weekly" has no file "nope.md". Its files: examples/good.md.');
    await say(rt, ana, space, "read gone", thread);
    assertEquals(outputs[4], 'No skill "gone" here. Yours: planning, weekly.');
    // The list is the same text turn after turn: the cache holds.
    assertEquals(listed(await prompt(rt, thread, "lead")), section);
  } finally {
    await rt.close();
  }
});

test("without skills, an agent's prompt has neither the list nor the tool", async () => {
  const rt = await start(memoryStore);
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const thread = await say(rt, ana, space, "hello");
    const lead = await prompt(rt, thread, "lead");
    assertEquals(listed(lead), undefined);
    assertEquals(lead.tools.map((t) => t.name).filter((n) => n === "read_skill"), []);
  } finally {
    await rt.close();
  }
});

test("a skill the app declares wrong stops the runtime from starting", async () => {
  await assertRejects(
    () => start(memoryStore, { "Weekly Report": weekly }),
    Error,
    'Skill "Weekly Report": A name is lowercase letters',
  );
  await assertRejects(
    () => start(memoryStore, { weekly: { ...weekly, files: { "../out.md": "x" } } }),
    Error,
    "isn't a plain path inside the skill",
  );
  await assertRejects(
    () => start(memoryStore, { weekly: { description: "No instructions" } }),
    Error,
    "it needs a description and instructions",
  );
});

each("a space's skills: its managers make them, its conversations use them", async (make) => {
  const rt = await start(make, { planning });
  try {
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    const { space: other } = await rt.call<{ space: string }>("space.create", {
      name: "Other",
    }, { actor: ana });
    await join(rt, launch, bob, "editor", ana);
    const { skill } = await rt.call<{ skill: string }>("skill.create", {
      in: launch,
      name: "weekly",
      description: "Write the weekly report.",
      instructions: "# Weekly\n\nShort bullets.",
      files: [{ path: "examples/good.md", text: "- Shipped" }],
    }, { actor: ana });

    // Listed for Launch's conversations, not Other's; the app's first, both by name.
    const here = await say(rt, ana, launch, "hello");
    const section = listed(await prompt(rt, here, "lead"))!;
    assert(section.indexOf("- planning:") < section.indexOf("- weekly: Write the weekly report."));
    const there = await say(rt, ana, other, "hello");
    assert(!listed(await prompt(rt, there, "lead"))!.includes("weekly"));

    // Bob (an editor) reads it through his agent, with its file.
    const bobs = await say(rt, bob, launch, "read weekly");
    assertStringIncludes(outputs.at(-1)!, "Short bullets.");
    assertStringIncludes(outputs.at(-1)!, "examples/good.md (9 characters)");
    await say(rt, bob, launch, "read weekly examples/good.md", bobs);
    assertEquals(outputs.at(-1), "weekly/examples/good.md:\n\n- Shipped");
    // In Other, there's no such skill.
    await say(rt, ana, other, "read weekly", there);
    assertEquals(outputs.at(-1), 'No skill "weekly" here. Yours: planning.');

    // Only managers change them; names are the space's and the app's own.
    assertEquals(
      await refused(rt.call("skill.create", {
        in: launch,
        name: "mine",
        description: "Mine.",
        instructions: "Mine.",
      }, { actor: bob })),
      "forbidden",
    );
    assertEquals(
      await refused(rt.call("skill.update", { skill, description: "Bob's." }, { actor: bob })),
      "forbidden",
    );
    assertEquals(await refused(rt.call("skill.delete", { skill }, { actor: bob })), "forbidden");
    for (const name of ["weekly", "planning", "Weekly Report"]) {
      assertEquals(
        await refused(rt.call("skill.create", {
          in: launch,
          name,
          description: "Again.",
          instructions: "Again.",
        }, { actor: ana })),
        "invalid",
        name,
      );
    }

    // What front ends list and read: the app's, then the space's; nothing for who isn't there.
    const shown = await rt.query<ShownSkill[]>("skill.list", { in: launch }, { actor: bob });
    assertEquals(shown.map((s) => [s._id.startsWith("app:") ? s._id : "made", s.source]), [
      ["app:planning", "app"],
      ["made", "space"],
    ]);
    assertEquals(shown[1].files, [{ path: "examples/good.md", size: 9 }]);
    const cy: Actor = { kind: "person", id: "cy" };
    assertEquals(
      (await rt.query<ShownSkill[]>("skill.list", { in: launch }, { actor: cy })).length,
      1,
    );
    assertEquals(await rt.query("skill.read", { skill }, { actor: cy }), null);
    const read = await rt.query<{ text: string }>("skill.read", { skill }, { actor: bob });
    assertEquals(read.text, "# Weekly\n\nShort bullets.");
    const app = await rt.query<{ text: string }>("skill.read", {
      skill: "app:planning",
      file: "templates.md",
    }, { actor: bob });
    assertStringIncludes(app.text, "## Task");

    // Renamed, its files replaced: the old file goes, the new one reads.
    await rt.call("skill.update", {
      skill,
      name: "weekly-report",
      instructions: "# Weekly\n\nThree bullets.",
      files: [{ path: "template.md", text: "## Shipped" }],
    }, { actor: ana });
    const after = await rt.query<ShownSkill[]>("skill.list", { in: launch }, { actor: ana });
    assertEquals(after[1].name, "weekly-report");
    assertEquals(after[1].files, [{ path: "template.md", size: 10 }]);
    assertEquals(
      await rt.query("skill.read", { skill, file: "examples/good.md" }, { actor: ana }),
      { skill: after[1], file: "examples/good.md", missing: true },
    );
    await say(rt, bob, launch, "read weekly-report", bobs);
    assertStringIncludes(outputs.at(-1)!, "Three bullets.");
    assertStringIncludes(outputs.at(-1)!, "template.md");

    // Deleted, with its files: no longer listed, nor read.
    await rt.call("skill.delete", { skill }, { actor: ana });
    assertEquals(
      (await rt.query<ShownSkill[]>("skill.list", { in: launch }, { actor: ana })).length,
      1,
    );
    assertEquals(await rt.query("skill.read", { skill }, { actor: ana }), null);
    await say(rt, bob, launch, "read weekly-report", bobs);
    assertEquals(outputs.at(-1), 'No skill "weekly-report" here. Yours: planning.');
  } finally {
    await rt.close();
  }
});

each("a new skill in a space changes that space's prompts only, once", async (make) => {
  const rt = await start(make);
  try {
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    const { space: other } = await rt.call<{ space: string }>("space.create", {
      name: "Other",
    }, { actor: ana });
    const thread = await say(rt, ana, launch, "hello");
    assertEquals(listed(await prompt(rt, thread, "lead")), undefined);
    const make_ = (in_: string, name: string) =>
      rt.call("skill.create", {
        in: in_,
        name,
        description: `About ${name}.`,
        instructions: `Do ${name}.`,
      }, { actor: ana });
    await make_(launch, "zeta");
    await make_(launch, "alpha");
    const section = listed(await prompt(rt, thread, "lead"))!;
    assert(section.indexOf("- alpha: About alpha.") < section.indexOf("- zeta: About zeta."));
    // Another space's new skill leaves this one's prompt exactly as it was.
    await make_(other, "beta");
    assertEquals(listed(await prompt(rt, thread, "lead")), section);
  } finally {
    await rt.close();
  }
});
