import { assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";
import { testEffect } from "../../../../runtime/testing/effects.ts";
import { httpRequestAction } from "./index.ts";

Deno.test("HTTP GET retries normally; mutations cannot redispatch after receipt or ambiguity", async () => {
  const saved = globalThis.fetch;
  try {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const lost of [false, true]) {
        let dispatches = 0;
        let begun = false;
        let outcome: unknown;
        globalThis.fetch = () => {
          dispatches++;
          return lost
            ? Promise.reject(new Error("reply lost"))
            : Promise.resolve(Response.json({ ok: true }));
        };
        const context = {
          signal: new AbortController().signal,
          effect: {
            ...testEffect,
            begin: () => {
              if (outcome !== undefined) {
                return Promise.resolve({ status: "replay", outcome } as never);
              }
              if (begun) {
                return Promise.reject(new Error("effect_indeterminate"));
              }
              begun = true;
              return Promise.resolve({ status: "proceed" } as const);
            },
            confirm: (_step: string, value: unknown) => {
              outcome = value;
              return Promise.resolve();
            },
          },
        } as unknown as ActionContext;
        const call = () =>
          Promise.resolve(
            httpRequestAction.execute(
              { url: "https://example.test", method },
              context,
            ),
          );
        if (lost) {
          await assertRejects(call);
          await assertRejects(call);
        } else {
          await call();
          await call();
        }
        assertEquals(dispatches, method === "GET" ? 2 : 1, `${method}/${lost}`);
      }
    }
  } finally {
    globalThis.fetch = saved;
  }
});
