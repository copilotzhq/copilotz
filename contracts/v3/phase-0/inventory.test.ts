import { assert, assertEquals } from "@std/assert";

import * as copilotz from "../../../index.ts";
import {
  COLLECTION_EVENT_TEMPLATES,
  CONVERSATION_READ_METHODS,
  CONVERSATION_WRITE_METHODS,
  DURABLE_EVENT_NAMES,
  EPHEMERAL_EVENT_NAMES,
  GENERIC_COLLECTION_NAMES,
  NATIVE_GRAPH_MUTATION_MODULES,
  PUBLIC_ROOT_FACTORIES,
  STREAM_COLLECTION_EXISTS,
} from "./inventory.ts";

const repositoryRoot = new URL("../../../", import.meta.url);

async function readProduction(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, repositoryRoot));
}

Deno.test("phase-0 public root factories remain the factory-first vocabulary", () => {
  for (const name of PUBLIC_ROOT_FACTORIES) {
    assertEquals(
      typeof (copilotz as Record<string, unknown>)[name],
      "function",
      name,
    );
  }
});

Deno.test("phase-0 native graph writers still exist and touch nodes or edges", async () => {
  for (const path of NATIVE_GRAPH_MUTATION_MODULES) {
    const source = await readProduction(path);
    assert(
      /INSERT INTO \$\{.*?(nodes|edges)|DELETE FROM \$\{.*?(nodes|edges)|UPDATE \$\{.*?nodes/s
        .test(source) ||
        /INSERT INTO " \+ context\.tables\.nodes/.test(source),
      `${path} no longer writes nodes or edges`,
    );
  }
});

Deno.test("phase-0 durable event names are still emitted by production modules", async () => {
  const sources = await Promise.all([
    readProduction("runtime/domain/conversation.ts"),
    readProduction("runtime/domain/llm-attempts.ts"),
    readProduction("runtime/domain/tool-executions.ts"),
    readProduction("runtime/domain/relations.ts"),
    readProduction("runtime/content/database-repository.ts"),
    readProduction("runtime/knowledge/collections.ts"),
    readProduction("runtime/knowledge/features.ts"),
    readProduction("runtime/knowledge/plugin.ts"),
    readProduction("plugins/core/resources/processors/message-router.ts"),
    readProduction("plugins/core/resources/processors/execute-text-attempt.ts"),
    readProduction("plugins/core/resources/processors/execute-tool.ts"),
    readProduction("plugins/core/resources/processors/project-text-result.ts"),
    readProduction("plugins/core/resources/processors/project-tool-result.ts"),
    readProduction("plugins/core/resources/processors/complete-ask.ts"),
    readProduction("plugins/core/resources/processors/fail-ask.ts"),
    readProduction("plugins/usage/plugin.ts"),
  ]);
  const joined = sources.join("\n");
  for (const name of DURABLE_EVENT_NAMES) {
    const [prefix] = name.split(".");
    assert(
      joined.includes(`"${name}"`) ||
        joined.includes(`"${prefix}."`) ||
        joined.includes("`" + prefix + ".${operation}`"),
      `durable event '${name}' is missing from production sources`,
    );
  }
});

Deno.test("phase-0 collection commands still emit named events, not only updated", async () => {
  const source = await readProduction("runtime/domain/collections.ts");
  for (const template of COLLECTION_EVENT_TEMPLATES) {
    const needle = template.replace("${name}", "${name}").replace(
      "${command}",
      "${command}",
    );
    assert(
      source.includes(needle),
      `missing collection event template ${template}`,
    );
  }
  assert(source.includes("type: `${name}.${command}`"));
  assert(source.includes("type: `${name}.updated`"));
});

Deno.test("phase-0 generic collections remain on the collection kernel", async () => {
  const sources = (
    await Promise.all([
      readProduction("runtime/schedules/collection.ts"),
      readProduction("plugins/usage/collection.ts"),
      readProduction("runtime/memory/collections.ts"),
      readProduction("runtime/knowledge/collections.ts"),
    ])
  ).join("\n");
  for (const name of GENERIC_COLLECTION_NAMES) {
    assert(
      sources.includes(`name: "${name}"`) || sources.includes(`= "${name}"`),
      `collection '${name}' missing`,
    );
  }
});

Deno.test("phase-0 conversation repository still exposes native read and write methods", async () => {
  const source = await readProduction("runtime/domain/conversation.ts");
  for (
    const method of [
      ...CONVERSATION_WRITE_METHODS,
      ...CONVERSATION_READ_METHODS,
    ]
  ) {
    assert(
      source.includes(`${method}(`) || source.includes(`${method}(`),
      method,
    );
  }
});

Deno.test("phase-0 has no stream collection and still uses ephemeral delta events", async () => {
  assertEquals(STREAM_COLLECTION_EXISTS, false);
  const conversation = await readProduction("runtime/domain/conversation.ts");
  assert(!/name:\s*"stream"/.test(conversation));
  const types = await readProduction("runtime/events/types.ts");
  for (const name of EPHEMERAL_EVENT_NAMES) {
    assert(types.includes(`"${name}"`), name);
  }
});
