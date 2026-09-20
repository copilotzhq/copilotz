import { assertEquals } from "@std/assert";
import { createCopilotzApplication } from "../runtime/application/index.ts";
import { definePlugin } from "@copilotz/copilotz/plugins";
import {
  createHttpAdapter,
  defineServerFacade,
  serverPlugin,
} from "../plugins/server/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";

Deno.test("custom HTTP body policy is bounded, raw when requested, authorized and route-local", async () => {
  let calls = 0;
  const application = await createCopilotzApplication({
    namespace: "tenant-a",
    databaseSchema: "http_body_policy",
    plugins: [definePlugin({
      id: "body-test",
      version: "1",
      plugins: [serverPlugin],
      resources: {
        server: {
          default: defineServerFacade({
            async authenticate(request) {
              if (request.headers.get("authorization") !== "Bearer fixture") {
                return new Response("Unauthorized", { status: 401 });
              }
              if (request.headers.has("x-auth-read")) {
                await request.clone().arrayBuffer();
              }
              return { namespace: "tenant-a" };
            },
          }),
        },
      },
      adapters: {
        http: {
          test: createHttpAdapter({
            routes: [
              {
                id: "raw",
                path: "/upload",
                method: "POST",
                body: { maxBytes: 2 * 1024 * 1024, raw: true },
                handler(context) {
                  calls++;
                  return {
                    bytes: (context.input as Uint8Array).byteLength,
                    raw: context.input instanceof Uint8Array,
                  };
                },
              },
              {
                id: "large-json",
                path: "/large-json",
                method: "POST",
                body: { maxBytes: 2 * 1024 * 1024 },
                handler(context) {
                  calls++;
                  return {
                    length: (context.input as { value: string }).value.length,
                  };
                },
              },
              {
                id: "tiny",
                path: "/tiny",
                method: "POST",
                body: { maxBytes: 4 },
                handler: () => {
                  calls++;
                  return {};
                },
              },
              {
                id: "normal",
                path: "/normal",
                method: "POST",
                handler(context) {
                  calls++;
                  return { input: context.input };
                },
              },
            ],
          }),
        },
      },
    })],
  });
  try {
    const fetch = createServerFacadeFetchHandler(application);
    const send = (path: string, body: BodyInit, headers: HeadersInit = {}) =>
      fetch(
        new Request(`https://example.test/api/${path}`, {
          method: "POST",
          body,
          headers: {
            authorization: "Bearer fixture",
            "content-type": "application/json",
            ...headers,
          },
        }),
      );
    const raw = await send("upload", new Uint8Array(1024 * 1024 + 1));
    assertEquals(raw.status, 200);
    assertEquals(await raw.json(), {
      data: { bytes: 1024 * 1024 + 1, raw: true },
    });
    assertEquals((await send("normal", '{"ok":true}')).status, 200);
    assertEquals(
      (await send("normal", new Uint8Array(1024 * 1024 + 1))).status,
      413,
    );
    assertEquals(
      (await send("upload", new Uint8Array(2 * 1024 * 1024 + 1))).status,
      413,
    );
    const chunked = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(3));
        c.enqueue(new Uint8Array(3));
        c.close();
      },
    });
    assertEquals((await send("tiny", chunked)).status, 413);
    assertEquals(
      (await send("upload", new Uint8Array(20), {
        authorization: "Bearer wrong",
      })).status,
      401,
    );
    const json = await send(
      "large-json",
      JSON.stringify({ value: "x".repeat(1024 * 1024) }),
    );
    assertEquals(json.status, 200);
    assertEquals(await json.json(), { data: { length: 1024 * 1024 } });
    const authRead = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(5));
        c.close();
      },
    });
    assertEquals(
      (await send("tiny", authRead, { "x-auth-read": "1" })).status,
      413,
    );
    assertEquals(calls, 3);
  } finally {
    await application.close();
  }
});
