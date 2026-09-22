import { assertEquals, assertRejects } from "@std/assert";
import type {
  ApplicationSendHandle,
  ApplicationSendInput,
} from "@copilotz/copilotz/application";
import { submitChannel } from "./index.ts";

function handle(id: string): ApplicationSendHandle {
  return {
    operationId: `operation-${id}`,
    eventId: `event-${id}`,
    correlationId: `correlation-${id}`,
    replayCursor: `cursor-${id}`,
    outputs: new ReadableStream(),
    done: Promise.resolve(),
    detach: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
}

Deno.test("submitChannel validates all occurrences before sending", async () => {
  let sends = 0;
  const application = {
    send(_input: ApplicationSendInput) {
      sends += 1;
      return Promise.resolve(handle(String(sends)));
    },
  };
  await assertRejects(
    () =>
      submitChannel(application, "web", [
        { id: "one", input: { ok: true } },
        { id: "two", input: { password: "secret" } },
      ]),
    TypeError,
  );
  assertEquals(sends, 0);
});

Deno.test("submitChannel preserves stable identity and clones operation metadata", async () => {
  const sent: ApplicationSendInput[] = [];
  const application = {
    send(input: ApplicationSendInput) {
      sent.push(input);
      return Promise.resolve(handle(String(sent.length)));
    },
  };
  const metadata = { access: { roles: ["agent"] } };
  await submitChannel(application, "web", [{ id: "same", input: {} }], {
    namespace: "tenant-a",
    databaseSchema: "channel_submit",
    operationMetadata: metadata,
  });
  await submitChannel(application, "web", [{ id: "same", input: {} }], {
    namespace: "tenant-a",
    databaseSchema: "channel_submit",
    operationMetadata: metadata,
  });
  assertEquals(sent[0].correlationId, sent[1].correlationId);
  assertEquals(sent[0].deduplicationId, sent[1].deduplicationId);
  assertEquals(sent[0].namespace, "tenant-a");
  assertEquals(sent[0].databaseSchema, "channel_submit");
  assertEquals(sent[0].operationMetadata, metadata);
  assertEquals(sent[0].operationMetadata === sent[1].operationMetadata, false);
});

Deno.test("submitChannel cancels every prior handle on partial failure", async () => {
  const cancelled: string[] = [];
  const first = handle("one");
  const second = handle("two");
  const application = {
    send(input: ApplicationSendInput) {
      if (input.payload && (input.payload as { id?: string }).id === "three") {
        return Promise.reject(new Error("send failed"));
      }
      const result =
        input.payload && (input.payload as { id?: string }).id === "one"
          ? first
          : second;
      const originalCancel = result.cancel;
      return Promise.resolve({
        ...result,
        cancel(reason?: string) {
          cancelled.push(`${result.operationId}:${reason}`);
          return originalCancel(reason);
        },
      });
    },
  };
  await assertRejects(
    () =>
      submitChannel(application, "web", [
        { id: "one", input: {} },
        { id: "two", input: {} },
        { id: "three", input: {} },
      ]),
    Error,
    "send failed",
  );
  assertEquals(cancelled, [
    "operation-one:channel_accept_failed",
    "operation-two:channel_accept_failed",
  ]);
});
