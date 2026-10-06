import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { defineSkill } from "../../index.ts";
import { skillManifest } from "../../shared/snapshots.ts";

const markdown = (description = "Plan work.", body = "Follow the plan.") =>
  `---\nname: planning\ndescription: ${description}\n---\n${body}`;

Deno.test("root skills contribute support automatically and cache authorized metadata with its body", async () => {
  let reads = 0;
  let text = markdown();
  const declaration = defineSkill({
    root: "https://example.test/skills/planning/",
    fetch: (() => {
      reads++;
      return Promise.resolve(
        new Response(text, { headers: { "content-type": "text/markdown" } }),
      );
    }) as typeof fetch,
  });
  assertEquals(reads, 0);
  const registry = createPluginRegistry({
    resources: { skills: { planning: declaration } },
  });
  assertEquals(reads, 0);
  assertEquals(typeof registry.actions.load_skill.execute, "function");
  const skill = registry.resources.skills.planning;
  const scope = registry.resources;
  assertEquals(
    (await skillManifest(skill, { scope })).description,
    "Plan work.",
  );
  assertEquals((await skill.load({ scope })).body, "Follow the plan.");
  assertEquals(reads, 1);
  const other = createPluginRegistry({
    resources: { skills: { planning: declaration } },
  });
  await other.resources.skills.planning.load({ scope: other.resources });
  assertEquals(reads, 2);
  const original = Date.now;
  try {
    Date.now = () => original() + 301_000;
    text = markdown("Updated plan.", "Updated body.");
    assertEquals(
      (await skill.load({ scope })).manifest.description,
      "Updated plan.",
    );
    assertEquals((await skill.load({ scope })).body, "Updated body.");
    assertEquals(reads, 3);
  } finally {
    Date.now = original;
  }
});

Deno.test("root skills read supporting files without an inventory and reject escaping redirects", async () => {
  const requests: string[] = [];
  const registry = createPluginRegistry({
    resources: {
      skills: {
        planning: defineSkill({
          root: "https://example.test/planning/",
          fetch: ((url) => {
            requests.push(String(url));
            return Promise.resolve(
              String(url).endsWith("escape.md")
                ? new Response(null, {
                  status: 302,
                  headers: { location: "https://elsewhere.test/secret.md" },
                })
                : new Response("supporting text"),
            );
          }) as typeof fetch,
        }),
      },
    },
  });
  const skill = registry.resources.skills.planning;
  assertEquals(
    await (await skill.read("references/new.md")).body instanceof
      ReadableStream,
    true,
  );
  await assertRejects(() => skill.read("../secret"), TypeError, "inside");
  await assertRejects(() => skill.read("escape.md"), TypeError, "inside");
  assertEquals(requests, [
    "https://example.test/planning/references/new.md",
    "https://example.test/planning/escape.md",
  ]);
  assertThrows(
    () => defineSkill({ root: "ftp://example.test/skills" }),
    TypeError,
    "HTTP",
  );
});

Deno.test("filesystem root skills enforce identity, symlink containment, and byte limits", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(root + "/SKILL.md", markdown());
    await Deno.mkdir(root + "/references");
    await Deno.writeTextFile(root + "/references/guide.md", "guide");
    await Deno.symlink(root + "/references/guide.md", root + "/link.md");
    const registry = createPluginRegistry({
      resources: { skills: { planning: defineSkill({ root }) } },
    });
    const skill = registry.resources.skills.planning;
    assertEquals(
      (await skill.load({ scope: registry.resources })).manifest.name,
      "planning",
    );
    assertEquals(
      new TextDecoder().decode(
        (await skill.read("references/guide.md")).body as Uint8Array,
      ),
      "guide",
    );
    await assertRejects(() => skill.read("link.md"), TypeError, "symlinks");
    await Deno.writeTextFile(root + "/large.md", "x".repeat(1_000_001));
    await assertRejects(() => skill.read("large.md"), RangeError, "limit");
    const wrong = createPluginRegistry({
      resources: { skills: { other: defineSkill({ root }) } },
    });
    await assertRejects(
      () => wrong.resources.skills.other.load(),
      Error,
      "different name",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("skill metadata never fetches ungranted roots and dynamic roots derive supporting readers", async () => {
  let forbiddenReads = 0;
  const registry = createPluginRegistry({
    resources: {
      skills: {
        planning: defineSkill({
          root: "https://example.test/planning/",
          fetch: (() =>
            Promise.resolve(new Response(markdown()))) as typeof fetch,
        }),
        hidden: defineSkill({
          root: "https://example.test/hidden/",
          fetch: (() => {
            forbiddenReads++;
            return Promise.resolve(new Response("hidden"));
          }) as typeof fetch,
        }),
      },
      agents: {
        planner: {
          id: "planner",
          name: "Planner",
          capabilities: { skills: ["planning"] },
        },
      },
    },
  });
  const resolved = registry.resources.capabilities.default.resolve({
    agent: "planner",
  }, { resources: registry.resources, actions: registry.actions } as never);
  assertEquals(
    resolved.tools.some((tool) => tool.id === "read_skill_resource"),
    true,
  );
  const catalog = await registry.resources.promptContext.skillsCatalog
    .contribute(
      {
        agent: registry.resources.agents.planner,
        context: {
          resources: registry.resources,
          actions: registry.actions,
          signal: new AbortController().signal,
        },
      } as never,
    );
  assertEquals(JSON.stringify(catalog).includes("Plan work."), true);
  assertEquals(forbiddenReads, 0);
});
