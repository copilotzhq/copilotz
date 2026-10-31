/**
 * An app's front, as its image runs it (no Dockerfile of its own): it runs
 * the job's command in the app's folder, giving it its port as `PORT`, and
 * once the job answers there, on this machine only, passes its own port on
 * to it, requests and WebSockets alike. When the job ends, so does it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import process from "node:process";
import { runtime, tempDir, test } from "../../../../testing/mod.ts";
import { FRONT, frontPort } from "../adapters/front.ts";

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
/** This runtime, running a script (Node's `http` either way). */
const exec = runtime === "deno" ? [g.Deno.execPath(), "run", "-A"] : [process.execPath];

/** The job: on 127.0.0.1 alone, at its PORT; it echoes what a WebSocket-like upgrade sends. */
const JOB = `import { createServer } from "node:http";
const server = createServer((req, res) => res.end("hello on " + process.env.PORT + " at " + req.url));
server.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  socket.on("data", (data) => socket.write("echo:" + data));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`;

/** A port nothing listens on now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const ended = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

test({
  name: "the front runs the job, and passes its port on to the job's on this machine, upgrades too",
  // The job runs in sh.
  ignore: process.platform === "win32",
  fn: async () => {
    const dir = tempDir();
    const target = await freePort();
    const port = await freePort();
    writeFileSync(join(dir, "front.mjs"), FRONT);
    writeFileSync(join(dir, "job.mjs"), JOB);
    // A list, as commands often are: its shell doesn't exec the job, so ending it takes more than ending the shell.
    writeFileSync(
      join(dir, "command"),
      "true && " + [...exec, "job.mjs"].map((a) => `"${a}"`).join(" "),
    );
    writeFileSync(join(dir, "port"), String(target));
    const front = spawn(exec[0], [...exec.slice(1), join(dir, "front.mjs")], {
      env: { ...process.env, PORT: String(port), CZ_CWD: dir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const done = ended(front);
    let said = "";
    front.stderr!.on("data", (data) => said += data);
    try {
      // Once the job answers, the front listens: the job's own port is its PORT.
      let page = "";
      for (let i = 0; i < 200 && !page; i++) {
        page = await fetch(`http://127.0.0.1:${port}/a?b`).then((r) => r.text(), () => "");
        if (!page) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertEquals(page, `hello on ${target} at /a?b`);
      assertStringIncludes(said, `:${port} -> 127.0.0.1:${target}`);

      // An upgrade goes through, both ways.
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(
            "GET /live HTTP/1.1\r\nHost: app.test\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n",
          );
        });
        let got = "";
        socket.on("data", (data) => {
          got += data;
          if (got.includes("\r\n\r\n") && !got.includes("echo:")) socket.write("ping");
          if (got.includes("echo:ping")) {
            socket.destroy();
            resolve(got);
          }
        });
        socket.on("error", reject);
      });
      assertStringIncludes(echoed, "101 Switching Protocols");
      assertStringIncludes(echoed, "echo:ping");
    } finally {
      front.kill("SIGTERM");
    }
    // Ended, it takes the job with it.
    await done;
    assert(!await fetch(`http://127.0.0.1:${target}/`).then(() => true, () => false));
  },
});

test("the front listens on 8080, unless the job serves that one", () => {
  assertEquals([frontPort(3000), frontPort(8080), frontPort(8081)], [8080, 8081, 8080]);
});
