/**
 * A preview's exchanges with a port the computer serves (`computer.http`):
 * the request's head and body go to its loopback, but for headers of one
 * hop; the response comes back as it's made (its head, every cookie its own,
 * then its body, streamed); redirects are answered, not followed; a port
 * nothing answers on gives 502; a head it can't take answers its failure.
 */
import { assert, assertEquals } from "@std/assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { test } from "../../../testing/mod.ts";
import {
  type Failed,
  type HttpRequestHead,
  type HttpResponseHead,
  type Scope,
  WORK,
} from "../computers/shared/workloads.ts";
import { splitHead } from "../computers/program/workloads/streams.ts";
import { type Setup, setup } from "./program-setup.ts";

const scope: Scope = { space: "s", folder: "alpha", who: "agent:a" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A local server on a free port, answering with `handler`. */
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on. */
async function freePort() {
  const server = await listen(() => {});
  await server.close();
  return server.port;
}

/** Sends `head` (and `body`, chunk by chunk) to computer c1: its output's head, and a reader of the rest. */
async function exchange(rt: Setup["rt"], head: unknown, body: string[] = []) {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify(head) + "\n" + (body[0] ?? "")));
      for (const chunk of body.slice(1)) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const job = await rt.workers.dispatch("computer", "c1", WORK.http, input);
  const split = await splitHead(job.output);
  return { head: split.head as HttpResponseHead & Partial<Failed>, reader: split.rest.getReader() };
}

/** What's left to read, as text. */
async function rest(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

const request = (port: number, more: Partial<HttpRequestHead>): HttpRequestHead => ({
  scope,
  port,
  method: "GET",
  path: "/",
  headers: [],
  ...more,
});

test("an exchange goes to the port, its headers but those of one hop, and comes back whole", async () => {
  const server = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(201, {
        "content-type": "application/json",
        "set-cookie": ["a=1; Path=/", "b=2; HttpOnly"],
        "x-kept": "yes",
        "keep-alive": "timeout=5",
      });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        custom: req.headers["x-custom"],
        cookie: req.headers.cookie,
        dropped: req.headers["x-drop"] ?? null,
        encoding: req.headers["accept-encoding"],
        body: Buffer.concat(chunks).toString(),
      }));
    });
  });
  try {
    await setup(async ({ rt }) => {
      const { head, reader } = await exchange(
        rt,
        request(server.port, {
          method: "POST",
          path: "/echo?x=1",
          headers: [
            ["content-type", "text/plain"],
            ["x-custom", "a"],
            ["cookie", "c=1"],
            ["connection", "keep-alive, x-drop"],
            ["x-drop", "1"],
            ["host", "preview.example"],
            ["accept-encoding", "compress"],
          ],
        }),
        ["hel", "lo ", "there"],
      );
      assertEquals(head.status, 201);
      const names = head.headers.map(([name]) => name);
      assert(!names.includes("keep-alive") && !names.includes("connection"), names.join());
      assertEquals(head.headers.filter(([name]) => name === "set-cookie"), [
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "b=2; HttpOnly"],
      ]);
      assert(head.headers.some(([name, value]) => name === "x-kept" && value === "yes"));
      const seen = JSON.parse(await rest(reader));
      // The encodings asked for are fetch's own, not the browser's.
      assert(!String(seen.encoding).includes("compress"), seen.encoding);
      assertEquals({ ...seen, encoding: undefined }, {
        method: "POST",
        url: "/echo?x=1",
        host: `127.0.0.1:${server.port}`,
        custom: "a",
        cookie: "c=1",
        dropped: null,
        encoding: undefined,
        body: "hello there",
      });

      // A path that looks like another host's stays this port's path.
      const tricky = await exchange(rt, request(server.port, { path: "//evil.example/x" }));
      assertEquals(tricky.head.status, 201);
      // It reached this port's server (Bun's collapses the leading slashes; Node's and Deno's don't).
      assert(
        ["//evil.example/x", "/evil.example/x"].includes(JSON.parse(await rest(tricky.reader)).url),
      );
    });
  } finally {
    await server.close();
  }
});

test("a response streams as it's made; a redirect is answered, not followed", async () => {
  let next!: () => void;
  const more = new Promise<void>((resolve) => next = resolve);
  const server = await listen((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/elsewhere" });
      return res.end();
    }
    if (req.url === "/gzip") {
      const body = gzipSync("plain text");
      res.writeHead(200, { "content-encoding": "gzip", "content-length": body.length });
      return res.end(body);
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first\n");
    void more.then(() => res.end("second\n"));
  });
  try {
    await setup(async ({ rt }) => {
      const { head, reader } = await exchange(rt, request(server.port, { path: "/stream" }));
      assertEquals(head.status, 200);
      // The first part arrives while the server holds back the rest.
      const first = await reader.read();
      assertEquals(decoder.decode(first.value), "first\n");
      next();
      assertEquals(await rest(reader), "second\n");

      const redirect = await exchange(rt, request(server.port, { path: "/redirect" }));
      assertEquals(redirect.head.status, 302);
      assert(
        redirect.head.headers.some(([name, value]) =>
          name === "location" && value === "/elsewhere"
        ),
      );
      await rest(redirect.reader);

      // Encoded all the same, it comes decoded, without its encoding (or its length).
      const encoded = await exchange(rt, request(server.port, { path: "/gzip" }));
      const names = encoded.head.headers.map(([name]) => name);
      assert(
        !names.includes("content-encoding") && !names.includes("content-length"),
        names.join(),
      );
      assertEquals(await rest(encoded.reader), "plain text");
    });
  } finally {
    await server.close();
  }
});

test("a port nothing answers on gives 502; a head it can't take, its failure", async () => {
  const port = await freePort();
  await setup(async ({ rt }) => {
    const { head, reader } = await exchange(rt, request(port, { path: "/x" }));
    assertEquals(head.status, 502);
    assert((await rest(reader)).includes(`port ${port}`));

    const unscoped = await exchange(rt, { ...request(port, {}), scope: { folder: "../x" } });
    assertEquals(unscoped.head.error?.code, "invalid");
    const absolute = await exchange(rt, request(port, { path: "http://example.com/" }));
    assertEquals(absolute.head.error?.code, "invalid");
    const outOfRange = await exchange(rt, request(70000, {}));
    assertEquals(outOfRange.head.error?.code, "invalid");
  });
});
