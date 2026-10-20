import type { ActionContext } from "@copilotz/copilotz/actions";
import { testEffect } from "../../../../runtime/testing/effects.ts";
import { assertEquals } from "@std/assert";
import { persistentTerminalAction } from "./index.ts";

Deno.test("Persistent Terminal Action has stable native identity", () => {
  const action = persistentTerminalAction;
  assertEquals(
    action.id,
    "copilotz.tools.persistent-terminal.persistent_terminal",
  );
});

Deno.test("Terminal reads remain ordinary while mutating dispatch replays only its receipt", async () => {
  for (
    const operation of [
      "info",
      "list",
      "export_file",
      "run",
      "restart",
      "close",
      "upload_asset",
    ] as const
  ) {
    let dispatches = 0;
    let begins = 0;
    let outcome: unknown;
    const context = {
      namespace: "space",
      signal: new AbortController().signal,
      action: { metadata: {} },
      adapters: {
        terminal: {
          default: {
            execute: () => {
              dispatches++;
              return Promise.resolve({ ok: true });
            },
          },
        },
      },
      effect: {
        ...testEffect,
        begin: () => {
          begins++;
          return Promise.resolve(
            outcome === undefined
              ? { status: "proceed" } as const
              : { status: "replay", outcome } as never,
          );
        },
        confirm: (_step: string, value: unknown) => {
          outcome = value;
          return Promise.resolve();
        },
      },
    } as unknown as ActionContext;
    const call = () =>
      persistentTerminalAction.execute({ action: operation }, context);
    assertEquals(await call(), { ok: true });
    assertEquals(await call(), { ok: true });
    const readOnly = ["info", "list", "export_file"].includes(operation);
    assertEquals(dispatches, readOnly ? 2 : 1, operation);
    assertEquals(begins, readOnly ? 0 : 2, operation);
  }
});
