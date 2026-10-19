/** Node 24 local owner. Static serving and ingress only; no embedded execution. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { listen } from "@copilotz/copilotz/adapters/node";
import { createOwner } from "./owner.ts";
const databaseUrl = process.env.COPILOTZ_TEST_POSTGRES_URL;
if (!databaseUrl) {
  throw new Error(
    "Set COPILOTZ_TEST_POSTGRES_URL to an isolated PostgreSQL database with pgvector.",
  );
}
const databaseSchema = process.env.DEMO_SCHEMA ?? "owner_two_agents_demo";
if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseSchema)) {
  throw new Error("Invalid DEMO_SCHEMA.");
}
const httpPort = Number(process.env.PORT ?? 48942),
  workerPort = Number(process.env.WORKER_PORT ?? 48941);
const capability = crypto.randomUUID(), origin = `http://127.0.0.1:${httpPort}`;
const owner = await createOwner({ databaseUrl, databaseSchema, capability });
const listener = await listen(owner.app, {
  hostname: "127.0.0.1",
  port: workerPort,
}).catch(async (error) => {
  await owner.app.close();
  throw error;
});
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript"]],
  ["/worker.mjs", ["worker.mjs", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);
const running = new Map<string, Promise<unknown>>();
const server = createServer((req, res) => {
  void (async () => {
    if (req.headers.host !== `127.0.0.1:${httpPort}`) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:${workerPort}; worker-src 'self'; frame-ancestors 'none'`,
    );
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/bootstrap" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          databaseSchema,
          capability,
          workerUrl: `ws://127.0.0.1:${workerPort}/workers`,
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/demo/run") {
      if (
        req.headers.authorization !== `Bearer ${capability}` ||
        req.headers.origin && req.headers.origin !== origin
      ) {
        res.writeHead(403).end();
        return;
      }
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (url.pathname === "/demo/run") {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const { runId } = JSON.parse(body.toString());
        if (typeof runId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(runId)) {
          res.writeHead(400).end();
          return;
        }
        if (running.size >= 8 && !running.has(runId)) {
          res.writeHead(429).end();
          return;
        }
        let promise = running.get(runId);
        if (!promise) {
          promise = owner.run(runId);
          running.set(runId, promise);
          promise.finally(() => running.delete(runId)).catch(() => undefined);
        }
        const result = await promise;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
        return;
      }
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [
            [key, Array.isArray(value) ? value.join(", ") : value] as [
              string,
              string,
            ],
          ]
        ),
        ...(body.length ? { body } : {}),
        signal: abort.signal,
      });
      const response = await owner.app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body) {
          if (res.destroyed) break;
          if (!res.write(chunk)) {
            await once(res, "drain", { signal: abort.signal });
          }
        }
      }
      res.end();
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", asset[1]);
    res.end(await readFile(new URL(asset[0], import.meta.url)));
  })().catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    if (!res.destroyed) res.end(JSON.stringify({ error: String(error) }));
  });
});
try {
  server.listen(httpPort, "127.0.0.1");
  await once(server, "listening");
} catch (error) {
  await owner.app.close();
  await listener.shutdown();
  throw error;
}
console.log(
  `Open ${origin}/ on this machine. Owner schema: ${databaseSchema}. Keep one demo tab open.`,
);
console.log(
  "Browser acceptance is established only by running the documented checks in a real browser.",
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void owner.app.close("demo_shutdown").finally(async () => {
      server.closeAllConnections();
      server.close();
      await listener.shutdown();
    });
  });
}
