import { assertEquals, assertExists } from "@std/assert";

import {
  type ChannelEntry,
  type ChannelOverrides,
  decorateChannelEntries,
  transformEgressDeliveryOutput,
} from "./channels.ts";

Deno.test("decorateChannelEntries applies ingress overrides using input and output", async () => {
  const channels: ChannelEntry[] = [
    {
      name: "web",
      ingress: {
        async handle(request) {
          return {
            status: 200,
            messages: [{
              message: request.body as never,
            }],
          };
        },
      },
    },
  ];

  const overrides: ChannelOverrides = {
    web: {
      ingress: {
        handle: ({ input, output }) => ({
          ...output,
          messages: (output.messages ?? []).map((envelope) => ({
            ...envelope,
            message: {
              ...envelope.message,
              thread: {
                ...(envelope.message.thread ?? {}),
                participants: [
                  String(input.context?.agent ?? "default-agent"),
                ],
              },
            },
          })),
        }),
      },
    },
  };

  const decorated = decorateChannelEntries(channels, overrides);
  const ingress = decorated?.[0]?.ingress;
  assertExists(ingress);

  const result = await ingress.handle(
    {
      method: "POST",
      headers: {},
      body: {
        content: "hi",
        thread: { externalId: "thread-1" },
      },
      context: { agent: "override-agent" },
      route: { ingress: "web", egress: "web" },
    },
    {} as never,
  );

  assertEquals(result.messages?.[0]?.message.thread?.participants, [
    "override-agent",
  ]);
});

Deno.test("decorateChannelEntries lets ingress overrides swallow messages with null", async () => {
  const channels: ChannelEntry[] = [
    {
      name: "web",
      ingress: {
        async handle(request) {
          return {
            status: 202,
            response: { status: "accepted" },
            messages: [{
              message: request.body as never,
            }],
          };
        },
      },
    },
  ];

  const decorated = decorateChannelEntries(channels, {
    web: {
      ingress: {
        handle: () => null,
      },
    },
  });

  const result = await decorated?.[0]?.ingress?.handle(
    {
      method: "POST",
      headers: {},
      body: { content: "hi" },
      route: { ingress: "web", egress: "web" },
    },
    {} as never,
  );

  assertEquals(result?.status, 202);
  assertEquals(result?.response, { status: "accepted" });
  assertEquals(result?.messages, []);
});

Deno.test("decorateChannelEntries lets egress overrides transform delivery output before send", async () => {
  const sent: unknown[] = [];
  const channels: ChannelEntry[] = [
    {
      name: "web",
      egress: {
        async deliver(context) {
          const output = await transformEgressDeliveryOutput(context, {
            text: "hello",
          });
          if (output !== null) sent.push(output);
        },
      },
    },
  ];

  const decorated = decorateChannelEntries(channels, {
    web: {
      egress: {
        deliver: ({ output }) => ({
          ...(output as Record<string, unknown>),
          text: "prefixed hello",
        }),
      },
    },
  });

  await decorated?.[0]?.egress?.deliver({
    route: { ingress: "web", egress: "web" },
    handle: { events: [], done: Promise.resolve() } as never,
    message: { content: "hi" } as never,
    copilotz: {} as never,
  });

  assertEquals(sent, [{ text: "prefixed hello" }]);
});
