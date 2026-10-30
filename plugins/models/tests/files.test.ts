/**
 * Files with messages: a model gets those it reads (the catalog says which
 * kinds, or the model choice for one it doesn't know), the latest first, up
 * to a count; any other is named in the text as left out.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRuntime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmMessage } from "../mod.ts";
import { resolve } from "../shared/choice.ts";
import { FILES, filesFor, mediumOf } from "../shared/files.ts";
import { test } from "../../../testing/mod.ts";

const png = { name: "a.png", type: "image/png", data: "iVBO" };
const pdf = { name: "b.pdf", type: "application/pdf", data: "JVBE" };
const csv = { name: "c.csv", type: "text/csv", data: "YSxi" };

test("a file's kind, as models read them", () => {
  assertEquals(
    ["image/png", "image/jpeg", "image/svg+xml", "application/pdf", "audio/mp4", "text/csv"].map(
      mediumOf,
    ),
    ["image", "image", undefined, "pdf", "audio", undefined],
  );
});

test("a model gets the files it reads; any other is named as left out", () => {
  const messages: LlmMessage[] = [{ role: "user", text: "look", files: [png, pdf, csv] }];
  assertEquals(filesFor(["image"], messages), [{
    role: "user",
    text: "look\n[b.pdf isn't shown: this model can't read pdf files]\n" +
      "[c.csv isn't shown: this model can't read text/csv files]",
    files: [png],
  }]);
  // Text only: every file is named as left out, and none goes.
  const [plain] = filesFor([], messages) as { text: string; files?: unknown }[];
  assertEquals(plain.files, undefined);
  assertStringIncludes(plain.text, "[a.png isn't shown: this model can't read image files]");
});

test("the latest files go, up to the count; the oldest are named as not sent again", () => {
  const many: LlmMessage[] = Array.from({ length: FILES.count + 2 }, (_, i) => ({
    role: "user",
    text: `${i}`,
    files: [{ ...png, name: `${i}.png` }],
  }));
  const out = filesFor(["image"], many) as { text: string; files?: { name: string }[] }[];
  assertEquals(out.filter((m) => m.files).length, FILES.count);
  assertEquals(out.at(-1)!.files![0].name, `${FILES.count + 1}.png`);
  assertStringIncludes(out[0].text, "older files aren't sent again");
});

test("the catalog says what a model reads", () => {
  const [m] = resolve({ provider: { openai: { apiKey: "k" } } }, "openai/gpt-6.1-sol");
  assert(m.info?.input?.includes("image"), "it reads images");
});

test("through the runtime: the model choice says what a model the catalog doesn't know reads", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [models] });
  const ask = (model: unknown) =>
    runtime.call<{ text: string }>("llm.generate", {
      model,
      messages: [{ role: "user", text: "look", files: [png] }],
    });
  try {
    assertStringIncludes((await ask({ model: "fake/echo", input: ["image"] })).text, "[saw a.png]");
    const blind = (await ask("fake/echo")).text;
    assertStringIncludes(blind, "a.png isn't shown: this model can't read image files");
    assert(!blind.includes("[saw"), "it saw nothing");
  } finally {
    await runtime.close();
  }
});
