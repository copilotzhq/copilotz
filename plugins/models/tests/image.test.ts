/**
 * The image port (`image.generate`), against a local server speaking
 * Gemini's API (and OpenAI's): the request (the prompt, the references as
 * inline parts, the shape and size asked), the images kept and answered by
 * id, a list's fallback, a refusal, and every call's use told, after the
 * org's limits had their say.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type Image, type Images, type ModelCall, type ModelUse } from "../mod.ts";
import { serve, test } from "../../../testing/mod.ts";

/** Base64 of a few bytes: what stands for an image here. */
const PNG = btoa("\x89PNG-made");
const DRAFT = btoa("\x89PNG-draft");
const REFERENCE = btoa("\x89PNG-reference");
const FILE = btoa("\xff\xd8\xffJPEG-file");

type Seen = { path: string; headers: Headers; body?: Record<string, unknown>; form?: FormData };

const USAGE = {
  promptTokenCount: 600,
  candidatesTokenCount: 1120,
  thoughtsTokenCount: 200,
  totalTokenCount: 1920,
};

/** Gemini's answer with an image: a draft while it thinks (left out), then its words and image. */
const made = (data = PNG) =>
  Response.json({
    candidates: [{
      content: {
        role: "model",
        parts: [
          { inlineData: { mimeType: "image/png", data: DRAFT }, thought: true },
          { text: "Here it is." },
          { inlineData: { mimeType: "image/png", data } },
        ],
      },
      finishReason: "STOP",
    }],
    usageMetadata: USAGE,
  });

/** A provider stand-in: records each request, and answers by model. */
async function server() {
  const seen: Seen[] = [];
  let busy = 0;
  const replies: Record<string, () => Response | Promise<Response>> = {
    "gemini-3-pro-image": () => made(),
    "gemini-3.1-flash-image": () => made(btoa("\x89PNG-flash")),
    broken: () => new Response("down", { status: 500 }),
    // It says something, and makes nothing.
    wordy: () =>
      Response.json({
        candidates: [{
          content: { parts: [{ text: "I'd rather describe it: a cat." }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
      }),
    // Its safety rules say no to what it would have made: its prompt is billed all the same.
    careful: () =>
      Response.json({
        candidates: [{ finishReason: "IMAGE_SAFETY", finishMessage: "Not this one." }],
        usageMetadata: { promptTokenCount: 12 },
      }),
    // The prompt itself is blocked.
    blocked: () => Response.json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }),
    busy: () => ++busy === 1 ? new Response("busy", { status: 503 }) : made(),
    silent: () => new Promise<Response>(() => {}),
  };
  const http = await serve(async (request) => {
    const url = new URL(request.url);
    const multipart = request.headers.get("content-type")?.startsWith("multipart/");
    const form = multipart ? await request.formData() : undefined;
    const text = form ? "" : await request.text();
    seen.push({
      path: url.pathname,
      headers: request.headers,
      ...(text ? { body: JSON.parse(text) } : {}),
      ...(form ? { form } : {}),
    });
    const gemini = /^\/v1beta\/models\/(.+):generateContent$/.exec(url.pathname);
    if (gemini) {
      return (replies[decodeURIComponent(gemini[1])] ??
        (() => new Response("?", { status: 404 })))();
    }
    if (url.pathname === "/v1/images/generations") {
      const { prompt, n = 1 } = JSON.parse(text) as { prompt: string; n?: number };
      if (prompt.includes("forbidden")) {
        return Response.json({
          error: {
            message: "Your request was rejected by the safety system.",
            code: "moderation_blocked",
          },
        }, { status: 400 });
      }
      return Response.json({
        data: Array.from({ length: n }, () => ({ b64_json: PNG })),
        output_format: "webp",
        usage: {
          input_tokens: 20,
          output_tokens: 4160,
          input_tokens_details: { cached_tokens: 0 },
        },
      });
    }
    if (url.pathname === "/v1/images/edits") {
      return Response.json({
        data: [{ b64_json: PNG }],
        usage: { input_tokens: 300, output_tokens: 4160 },
      });
    }
    return new Response("unknown", { status: 404 });
  });
  return { url: http.url, seen, close: () => http.close() };
}

/** A runtime whose `google` and `openai` are the stand-in; it hears every use, and may say no. */
async function started(
  mock: { url: string },
  resources: Record<string, Record<string, unknown>> = {},
  refuse?: (call: ModelCall) => void,
) {
  const uses: ModelUse[] = [];
  const asked: ModelCall[] = [];
  const app = definePlugin({
    name: "app",
    collections: {
      // A collection of the app's own holding files, as chat's `file` does.
      file: {
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string" },
            data: { type: "string" },
          },
        },
      },
    },
    actions: {
      "test.image": defineAction({
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        run: (ctx, input) => ctx.db.collection<Image>("image").findOne({ _id: input.id }),
      }),
      "test.file": defineAction({
        input: { type: "object" },
        run: async (ctx, input) => (await ctx.db.collection("file").insertOne(input)).insertedId,
      }),
    },
    resources: {
      provider: {
        google: { apiKey: "g-key", baseURL: `${mock.url}/v1beta` },
        openai: { apiKey: "o-key", baseURL: `${mock.url}/v1` },
        ...resources.provider,
      },
      modelUse: {
        test: {
          used: (_: unknown, use: ModelUse) => void uses.push(use),
          may: (_: unknown, call: ModelCall) => {
            asked.push(call);
            refuse?.(call);
          },
        },
      },
      ...Object.fromEntries(Object.entries(resources).filter(([kind]) => kind !== "provider")),
    },
  });
  const runtime = await createRuntime({ store: memoryStore(), plugins: [models, app] });
  return { runtime, uses, asked };
}

const code = (error: unknown) => (error as { code?: string }).code;

test("an image from a prompt: Gemini asked for images, the image kept and answered by id", async () => {
  const mock = await server();
  const { runtime, uses, asked } = await started(mock);
  try {
    const answer = await runtime.call<Images>("image.generate", {
      model: "google/gemini-3-pro-image",
      prompt: "A cat on a carousel, pastel",
      aspectRatio: "4:5",
      size: "2K",
      tags: { thread: "t1", purpose: "post" },
    });
    // Its words, and the image it made (not its draft), kept: an id, a media type, a size.
    assertEquals(answer.text, "Here it is.");
    assertEquals(answer.images.length, 1);
    const [{ id, type, size }] = answer.images;
    assertEquals([type, size], ["image/png", 9]);
    assertEquals(answer.usage, {
      model: "google/gemini-3-pro-image",
      input: 600,
      output: 1320,
      reasoning: 200,
    });
    const kept = await runtime.call<Image>("test.image", { id });
    assertEquals([kept.data, kept.type, kept.size, kept.model, kept.tags], [
      PNG,
      "image/png",
      9,
      "google/gemini-3-pro-image",
      { thread: "t1", purpose: "post" },
    ]);
    // What Gemini was asked.
    const [request] = mock.seen;
    assertEquals(request.path, "/v1beta/models/gemini-3-pro-image:generateContent");
    assertEquals(request.headers.get("x-goog-api-key"), "g-key");
    assertEquals(request.body, {
      contents: [{ role: "user", parts: [{ text: "A cat on a carousel, pastel" }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "4:5", imageSize: "2K" },
      },
    });
    // Asked before, told after: an image's use, priced by its catalog entry.
    assertEquals(asked, [{
      meter: "image",
      subject: "google/gemini-3-pro-image",
      tags: { thread: "t1", purpose: "post" },
    }]);
    assertEquals(uses, [{
      meter: "image",
      subject: "google/gemini-3-pro-image",
      catalog: "google/gemini-3-pro-image",
      quantities: { input: 600, output: 1320, reasoning: 200 },
      tags: { thread: "t1", purpose: "post" },
    }]);
  } finally {
    await runtime.close();
    await mock.close();
  }
});

test("references go after the prompt, in order: one given, one made here, a file the caller reads", async () => {
  const mock = await server();
  const { runtime } = await started(mock);
  try {
    const first = await runtime.call<Images>("image.generate", {
      model: "google/gemini-3-pro-image",
      prompt: "A logo",
    });
    const file = await runtime.call<string>("test.file", {
      name: "brand.jpg",
      type: "image/jpeg",
      data: FILE,
    });
    mock.seen.length = 0;
    await runtime.call<Images>("image.generate", {
      model: "google/gemini-3-pro-image",
      prompt: "The logo on a mug",
      references: [
        { data: `data:image/webp;base64,${REFERENCE}` },
        { id: first.images[0].id },
        { id: file, collection: "file" },
      ],
      count: 2,
    });
    // Two images asked: two calls, each with the prompt and its references.
    assertEquals(mock.seen.length, 2);
    for (const { body } of mock.seen) {
      assertEquals((body!.contents as { parts: unknown[] }[])[0].parts, [
        { text: "The logo on a mug" },
        { inlineData: { mimeType: "image/webp", data: REFERENCE } },
        { inlineData: { mimeType: "image/png", data: PNG } },
        { inlineData: { mimeType: "image/jpeg", data: FILE } },
      ]);
    }
    // What isn't an image, or isn't there, is refused before anything is asked.
    mock.seen.length = 0;
    const refused = await Promise.all([
      { data: btoa("plain"), type: "text/plain" },
      { id: "nope" },
      { id: file, data: PNG },
      { data: "not base64!", type: "image/png" },
    ].map((reference) =>
      runtime.call("image.generate", {
        model: "google/gemini-3-pro-image",
        prompt: "x",
        references: [reference],
      }).then(() => "made", code)
    ));
    assertEquals(refused, ["invalid", "not_found", "invalid", "invalid"]);
    assertEquals(mock.seen.length, 0);
  } finally {
    await runtime.close();
    await mock.close();
  }
});

test("several images at once: as many calls, their images and their use added up", async () => {
  const mock = await server();
  const { runtime, uses } = await started(mock);
  try {
    const answer = await runtime.call<Images>("image.generate", {
      model: "google/gemini-3-pro-image",
      prompt: "Three variations",
      count: 3,
    });
    assertEquals(answer.images.length, 3);
    assertEquals(new Set(answer.images.map((image) => image.id)).size, 3);
    assertEquals(answer.text, "Here it is.\nHere it is.\nHere it is.");
    assertEquals(uses.map((use) => use.quantities), [{
      input: 1800,
      output: 3960,
      reasoning: 600,
    }]);
  } finally {
    await runtime.close();
    await mock.close();
  }
});

test("a list: a model that fails or makes nothing hands over to the next, at once", async () => {
  const mock = await server();
  const { runtime, uses } = await started(mock, {
    model: { images: ["google/broken", "google/wordy", "google/gemini-3.1-flash-image"] },
  });
  try {
    const answer = await runtime.call<Images>("image.generate", {
      model: "images",
      prompt: "A cat",
    });
    assertEquals(answer.usage?.model, "google/gemini-3.1-flash-image");
    assertEquals(
      mock.seen.map((s) => s.path.split("/").at(-1)),
      ["broken:generateContent", "wordy:generateContent", "gemini-3.1-flash-image:generateContent"],
    );
    // What the one that made nothing used is told too.
    assertEquals(uses.map((use) => use.subject), ["google/wordy", "google/gemini-3.1-flash-image"]);
    // The last one making nothing says so, with what it said.
    const error = await assertRejects(() =>
      runtime.call("image.generate", { model: "google/wordy", prompt: "A cat" })
    );
    assertEquals(code(error), "no_image");
    assertEquals(
      (error as Error).message,
      "google/wordy made no image: I'd rather describe it: a cat.",
    );
  } finally {
    await runtime.close();
    await mock.close();
  }
});

test("a refusal (its safety rules) stops there: no other model is asked, and its use is told", async () => {
  const mock = await server();
  const { runtime, uses } = await started(mock);
  try {
    const error = await assertRejects(() =>
      runtime.call("image.generate", {
        model: ["google/careful", "google/gemini-3-pro-image"],
        prompt: "Something it won't draw",
      })
    );
    assertEquals(code(error), "image_refused");
    assertEquals(
      (error as Error).message,
      "google/careful wouldn't make this image (IMAGE_SAFETY: Not this one.)",
    );
    assertEquals(mock.seen.length, 1);
    assertEquals(uses.map((use) => [use.subject, use.quantities]), [
      ["google/careful", { input: 12, output: 0 }],
    ]);
    // A blocked prompt is a refusal too.
    const blocked = await assertRejects(() =>
      runtime.call("image.generate", { model: "google/blocked", prompt: "Worse" })
    );
    assertEquals(code(blocked), "image_refused");
    assertEquals(
      (blocked as Error).message,
      "google/blocked wouldn't make this image (PROHIBITED_CONTENT)",
    );
  } finally {
    await runtime.close();
    await mock.close();
  }
});

test("the last model, busy, is tried again; one silent past its provider's silence hands over", async () => {
  const mock = await server();
  const { runtime } = await started(mock, {
    provider: { slow: { adapter: "gemini", baseURL: `${mock.url}/v1beta`, silence: 50, retry: 0 } },
  });
  try {
    const answer = await runtime.call<Images>("image.generate", {
      model: "google/busy",
      prompt: "A cat",
    });
    assertEquals(answer.images.length, 1);
    assertEquals(mock.seen.length, 2);
    mock.seen.length = 0;
    const handed = await runtime.call<Images>("image.generate", {
      model: ["slow/silent", "google/gemini-3.1-flash-image"],
      prompt: "A cat",
    });
    assertEquals(handed.usage?.model, "google/gemini-3.1-flash-image");
    // Alone, it fails as stalled, and its retry (none) is spent.
    const error = await assertRejects(() =>
      runtime.call("image.generate", { model: "slow/silent", prompt: "A cat" })
    );
    assertEquals(code(error), "stalled");
  } finally {
    await runtime.close();
    await mock.close();
  }
});

test("before a call, whoever listens to model use, or the org's limits, may refuse it", async () => {
  const mock = await server();
  const listening = await started(mock, {}, () => {
    throw Object.assign(new Error("This line's budget is spent."), { code: "budget" });
  });
  try {
    const error = await assertRejects(() =>
      listening.runtime.call("image.generate", {
        model: ["google/gemini-3-pro-image", "google/gemini-3.1-flash-image"],
        prompt: "A cat",
      })
    );
    assertEquals(code(error), "budget");
  } finally {
    await listening.runtime.close();
  }
  // The org's spending check: no credits left.
  const checks: unknown[] = [];
  const checking = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      definePlugin({
        name: "limits",
        actions: {
          "test.check": defineAction({
            input: { type: "object" },
            record: false,
            run: (_ctx, input) => {
              checks.push(input);
              return { ok: false, why: "no_credits", message: "Out of credits." };
            },
          }),
        },
        resources: {
          provider: { google: { apiKey: "g-key", baseURL: `${mock.url}/v1beta` } },
          spending: { check: "test.check" },
        },
      }),
    ],
  });
  try {
    const error = await assertRejects(() =>
      checking.call("image.generate", {
        model: "google/gemini-3-pro-image",
        prompt: "A cat",
        tags: { purpose: "post" },
      })
    );
    assertEquals([code(error), (error as Error).message], ["no_credits", "Out of credits."]);
    assertEquals(checks, [{ purpose: "post" }]);
    assertEquals(mock.seen.length, 0);
  } finally {
    await checking.close();
    await mock.close();
  }
});

test("openai: generations, edits with references (multipart), and its safety system's refusal", async () => {
  const mock = await server();
  const { runtime, uses } = await started(mock);
  try {
    const answer = await runtime.call<Images>("image.generate", {
      model: { model: "openai/gpt-image-2", options: { quality: "high", output_format: "webp" } },
      prompt: "A cat",
      count: 2,
      aspectRatio: "9:16",
    });
    assertEquals(answer.images.map((image) => image.type), ["image/webp", "image/webp"]);
    assertEquals(mock.seen[0].body, {
      model: "gpt-image-2",
      prompt: "A cat",
      n: 2,
      size: "1024x1536",
      quality: "high",
      output_format: "webp",
    });
    assertEquals(mock.seen[0].headers.get("authorization"), "Bearer o-key");
    assertEquals(uses[0].quantities, { input: 20, output: 4160 });
    await runtime.call<Images>("image.generate", {
      model: "openai/gpt-image-2",
      prompt: "The cat, in a hat",
      references: [{ data: REFERENCE, type: "image/png" }],
    });
    const edit = mock.seen.at(-1)!;
    assertEquals(edit.path, "/v1/images/edits");
    const [file] = edit.form!.getAll("image[]") as File[];
    assertEquals([file.name, file.size, edit.form!.get("prompt")], [
      "reference-1.png",
      14,
      "The cat, in a hat",
    ]);
    const error = await assertRejects(() =>
      runtime.call("image.generate", { model: "openai/gpt-image-2", prompt: "Something forbidden" })
    );
    assertEquals(code(error), "image_refused");
  } finally {
    await runtime.close();
    await mock.close();
  }
});

test("offline (fake), and checked like any port's model at startup", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [models] });
  try {
    const answer = await runtime.call<Images>("image.generate", {
      model: "fake/image",
      prompt: "A cat",
      references: [{ data: PNG, type: "image/png" }],
    });
    assertEquals(answer.text, "(An image of: A cat, from 1 reference(s).)");
    assertEquals([answer.images[0].type, answer.images[0].size], ["image/png", 70]);
    await runtime.call("models.check", { model: "fake/image", port: "image" });
    const error = await assertRejects(() =>
      runtime.call("models.check", { model: "hash/words", port: "image" })
    );
    assert((error as Error).message.startsWith('No image adapter "hash"'));
  } finally {
    await runtime.close();
  }
});
