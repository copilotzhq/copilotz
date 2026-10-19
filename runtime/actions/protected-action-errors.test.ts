import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ActionError,
  isCallerSafeActionStatus,
  standardActionError,
} from "./errors.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { parseActionLifecycleEvent } from "./event.ts";
Deno.test("owner standard errors discard private details and allow only exact authentication unavailable503", async () => {
  for (
    const [code, status, message] of [
      ["forbidden", 403, "Forbidden"],
      ["unauthorized", 401, "Unauthorized"],
      ["credential_unavailable", 401, "Credential unavailable"],
      ["invalid_input", 400, "Invalid input"],
      ["auth_unavailable", 503, "Authentication is unavailable"],
    ] as const
  ) {
    const error = standardActionError(
      Object.assign(new Error("private-token"), {
        code,
        status,
        cause: "private-token",
        data: "private-token",
      }),
    )!;
    assert(error instanceof ActionError);
    assertEquals(error.message, message);
    assertEquals(error.code, code);
    assertEquals(error.status, status);
    assertEquals(error.cause, undefined);
    assert(!JSON.stringify(error).includes("private-token"));
    let parsed: unknown;
    const lifecycle = createActionLifecycleEmitter({
      namespace: "space",
      append(input) {
        parsed = parseActionLifecycleEvent({
          ...input.draft,
          durable: true,
          type: input.draft.type,
          namespace: "space",
          metadata: input.draft.metadata,
          data: input.data,
          payload: {
            dataRef: {
              eventBodyId: "event-body:space:run:action:terminal",
              schemaVersion: 1,
              mediaType: "application/json",
            },
          },
        });
        if (input.data.status === "failed") {
          for (
            const error of [
              {
                ...input.data.error,
                status: 503,
                code: "other_unavailable",
                callerSafe: true,
              },
              {
                ...input.data.error,
                status: 503,
                code: "auth_unavailable",
                message: "private-token",
                callerSafe: true,
              },
            ]
          ) {
            assertEquals(
              parseActionLifecycleEvent({
                ...input.draft,
                metadata: input.draft.metadata,
                durable: true,
                payload: {
                  dataRef: {
                    eventBodyId: "event-body:space:run:action:terminal",
                    schemaVersion: 1,
                    mediaType: "application/json",
                  },
                },
                data: { ...input.data, error },
              }),
              null,
            );
          }
        }
        return Promise.resolve({ deduplicated: false } as never);
      },
    });
    await lifecycle.emit({
      actionId: "fixture",
      actionRunId: "run",
      metadata: {},
      input: {},
      deduplicationId: "run:action:terminal",
      status: "failed",
      error: {
        name: error.name,
        message: error.message,
        code: error.code,
        status: error.status,
        callerSafe: true,
      },
    });
    assert(parsed);
  }
  assertEquals(
    standardActionError(
      Object.assign(new Error("private"), {
        code: "private-token",
        status: 403,
      }),
    ),
    undefined,
  );
  assertEquals(
    standardActionError(
      Object.assign(new Error("private"), { code: "forbidden", status: 500 }),
    ),
    undefined,
  );
  assertThrows(
    () =>
      new ActionError("private-token", {
        code: "auth_unavailable",
        status: 503,
      }),
    RangeError,
  );
  assertThrows(
    () => new ActionError("private-token", { code: "other", status: 500 }),
    RangeError,
  );
  assertEquals(
    isCallerSafeActionStatus(503, "auth_unavailable", "private-token"),
    false,
  );
});
