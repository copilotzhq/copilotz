import { assert, assertEquals } from "@std/assert";

import { createCopilotz } from "../runtime/application/index.ts";
import type { AttachmentOutput } from "../runtime/attachments/index.ts";
import type {
  ChannelRequest,
  ChannelResource,
  ChannelRuntime,
} from "../runtime/channels/index.ts";
import { createEphemeralEvent } from "../runtime/events/index.ts";
import type { EventNativeApp, EventNativeAppRequest } from "./event-native.ts";
import { createEventNativeFetchHandler } from "./fetch.ts";
import { createV1FetchHandler, createV1RouteAdapter } from "./v1-fetch.ts";

const NAMESPACE = "tenant-a";

Deno.test("v1 route adapter isolates providers and admin aliases from the native app", async () => {
  const seen: EventNativeAppRequest[] = [];
  const native: EventNativeApp = Object.freeze({
    resources: () => Object.freeze([]),
    handle(request) {
      seen.push(request);
      return Promise.resolve({ status: 200, data: request.path });
    },
  });
  const handle = createEventNativeFetchHandler(createV1RouteAdapter(native), {
    basePath: "/v1",
  });

  assertEquals(
    (await handle(
      new Request("https://example.test/v1/providers/web/to/zendesk"),
    ))
      .status,
    200,
  );
  assertEquals(seen[0].resource, "channels");
  assertEquals(seen[0].path, ["web", "to", "zendesk"]);

  assertEquals(
    (await handle(new Request("https://example.test/v1/admin/overview")))
      .status,
    200,
  );
  assertEquals(seen[1].resource, "features");
  assertEquals(seen[1].path, ["admin", "overview"]);

  await handle(new Request("https://example.test/v1/threads/thread-a"));
  assertEquals(seen[2].resource, "threads");
  assertEquals(seen[2].path, ["thread-a"]);

  await handle(
    new Request(
      "https://example.test/v1/threads?participantId=user-a&status=all&order=desc",
    ),
  );
  assertEquals(seen[3].resource, "threads");
  assertEquals(seen[3].query, {
    participantId: "user-a",
    order: "desc",
  });

  await handle(
    new Request("https://example.test/v1/threads?status=active"),
  );
  assertEquals(seen[4].query, { status: "active" });
});

Deno.test("v1 Fetch handler isolates legacy providers projection from canonical channels", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v1_fetch",
    core: false,
  });
  let dispatched: ChannelRequest | undefined;
  const channel: ChannelResource = Object.freeze({
    id: "web",
    ingress: Object.freeze({ handle: () => ({ inputs: [] }) }),
    egress: Object.freeze({ requestBound: true, deliver: () => undefined }),
  });
  const channels: ChannelRuntime = Object.freeze({
    list: () => [channel],
    get: (id) => id === "web" ? channel : undefined,
    async dispatch(_namespace, request) {
      dispatched = request;
      const done = Promise.resolve(request.callback!(createEphemeralEvent({
        type: "text.delta",
        namespace: NAMESPACE,
        threadId: "thread-a",
        payload: {
          text: "Hello",
          agent: { id: "support", name: "Support" },
        },
        correlationId: "correlation-a",
      }) as AttachmentOutput)).then(() => undefined);
      return Object.freeze({
        status: 200,
        requestBound: true,
        executions: Object.freeze([]),
        done,
        cancel: () => Promise.resolve(),
      });
    },
  });
  try {
    const handler = createV1FetchHandler(application, {
      appOptions: { channels },
      resolveContext: (request) => ({
        namespace: NAMESPACE,
        originalUrl: request.url,
      }),
    });
    const response = await handler(
      new Request("https://example.test/v1/providers/web", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hello" }),
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    assertEquals(dispatched?.route, { ingress: "web", egress: "web" });
    assertEquals(
      dispatched?.context?.originalUrl,
      "https://example.test/v1/providers/web",
    );
    const streamed = (await response.text()).trim();
    assert(streamed.startsWith("event: TOKEN\ndata: "));
    const frame = JSON.parse(
      streamed.split("\ndata: ", 2)[1],
    ) as Record<string, unknown>;
    assertEquals(frame.type, "TOKEN");
    assertEquals(
      (frame.payload as Record<string, unknown>).token,
      "Hello",
    );

    const canonicalResponse = await handler(
      new Request("https://example.test/v1/channels/web", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hello canonically" }),
      }),
    );
    assertEquals(canonicalResponse.status, 200);
    const canonicalStreamed = (await canonicalResponse.text()).trim();
    assert(canonicalStreamed.startsWith("event: text.delta\ndata: "));
    const canonicalFrame = JSON.parse(
      canonicalStreamed.split("\ndata: ", 2)[1],
    ) as Record<string, unknown>;
    assertEquals(canonicalFrame.type, "text.delta");
    assertEquals(canonicalFrame.durable, false);
  } finally {
    await application.shutdown();
  }
});

Deno.test("v1 Fetch compatibility remains factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(
    new URL("v1-fetch.ts", import.meta.url),
  );
  assert(!/\bDeno\./.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
});
