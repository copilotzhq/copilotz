import { assertEquals, assertRejects } from "@std/assert";
import { CopilotzHttpError, createCopilotzClient } from "./index.ts";

Deno.test("result unavailability preserves the receipt and never resubmits or fabricates a terminal result", async () => {
  const receipt = Object.freeze({
    operationId: "retained-operation",
    correlationId: "retained-correlation",
    status: "accepted",
    acceptedAt: "2026-10-19T00:00:00Z",
  });
  const requests: {
    path: string;
    method: string;
    key: string | null;
    body: string | null;
  }[] = [];
  let resultAvailable = false;
  const client = createCopilotzClient({
    baseUrl: "https://result.test/api",
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        method: request.method,
        key: request.headers.get("idempotency-key"),
        body: request.body ? await request.text() : null,
      });
      if (request.method === "POST") {
        return Response.json({ data: receipt }, { status: 202 });
      }
      if (path.endsWith("/result")) {
        return resultAvailable
          ? Response.json({ data: "authoritative-later-result" })
          : Response.json({
            error: {
              code: "operation_result_unavailable",
              message: "Operation result is unavailable.",
            },
          }, { status: 409 });
      }
      return Response.json({ data: { ...receipt, state: "running" } });
    }) as typeof fetch,
  });
  const accepted = await client.actions.submit("fixture.run", {
    value: "retained",
  }, { idempotencyKey: "original-key" });
  assertEquals(accepted, receipt);
  const error = await assertRejects(
    () => client.operations.result(accepted.operationId),
    CopilotzHttpError,
  );
  assertEquals({
    code: error.code,
    status: error.status,
    message: error.message,
  }, {
    code: "operation_result_unavailable",
    status: 409,
    message: "Operation result is unavailable.",
  });
  assertEquals(accepted, receipt);
  assertEquals(requests, [
    {
      path: "/api/actions/fixture/run",
      method: "POST",
      key: "original-key",
      body: '{"value":"retained"}',
    },
    {
      path: "/api/operations/retained-operation/result",
      method: "GET",
      key: null,
      body: null,
    },
  ]);
  assertEquals(await client.operations.get(accepted.operationId), {
    data: { ...receipt, state: "running" },
  });
  // A later explicit read may recover an authoritative result. The client never
  // caches the refusal as completed/failed/cancelled or generates a new key.
  resultAvailable = true;
  assertEquals(
    await client.operations.result(accepted.operationId),
    "authoritative-later-result",
  );
  assertEquals(requests.filter(({ method }) => method !== "GET").length, 1);
});

Deno.test("result-only invocation propagates read refusal without a replacement admission", async () => {
  const requests: { method: string; key: string | null }[] = [];
  const client = createCopilotzClient({
    baseUrl: "https://result.test/api",
    fetch: ((input, init) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        key: request.headers.get("idempotency-key"),
      });
      return Promise.resolve(
        request.method === "POST"
          ? Response.json({ data: { operationId: "original-operation" } }, {
            status: 202,
          })
          : Response.json({
            error: {
              code: "operation_result_unavailable",
              message: "Operation result is unavailable.",
            },
          }, { status: 409 }),
      );
    }) as typeof fetch,
  });
  await assertRejects(
    () =>
      client.actions.invoke("fixture.run", {}, {
        idempotencyKey: "original-key",
      }),
    CopilotzHttpError,
    "Operation result is unavailable.",
  );
  assertEquals(requests, [{ method: "POST", key: "original-key" }, {
    method: "GET",
    key: null,
  }]);
});
