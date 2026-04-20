import { assertEquals, assertExists } from "@std/assert";

import {
  type ChannelEntry,
  type ChannelOverrides,
  decorateChannelEntries,
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
