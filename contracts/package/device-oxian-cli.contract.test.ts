import { assert, assertEquals } from "@std/assert";
import { WebSocket as Socket } from "ws";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";

async function bounded<T>(promise: Promise<T>, ms = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Oxian CLI device timeout")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
for (const transport of ["in-process", "websocket"]) {
  Deno.test(`SEC3 real Oxian CLI start ${transport}: facade upgrade, snapshot and origin refusal`, async () => {
    const root = await Deno.makeTempDir({ prefix: "copilotz-device-cli-" });
    const schema = `device_cli_${crypto.randomUUID().replaceAll("-", "")}`;
    await Deno.mkdir(`${root}/routes/api`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/routes/api/device.ts`,
      `export function GET(request, context) { return context.state.handler(request); }`,
    );
    await Deno.writeTextFile(
      `${root}/app.ts`,
      `export { default } from ${
        JSON.stringify(
          new URL("./fixtures/device-oxian-route.ts", import.meta.url).href,
        )
      };`,
    );
    await Deno.writeTextFile(
      `${root}/oxian.config.ts`,
      `export default {application:{routesRoot:'./routes',factory:'./app.ts'},gateway:{workerTransport:'${transport}',listener:{hostname:'127.0.0.1',port:0},hypervisor:{shutdownTimeoutMs:500,cancellationAckTimeoutMs:500}}};`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--node-modules-dir=auto",
        "-A",
        "--config",
        new URL("../../deno.json", import.meta.url).pathname,
        import.meta.resolve("@oxian/oxian-js/bin"),
        "start",
        "--config",
        `${root}/oxian.config.ts`,
      ],
      cwd: root,
      env: { SEC3_CLI_SCHEMA: schema },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const started = Promise.withResolvers<string>();
    const disposed = Promise.withResolvers<void>();
    let log = "";
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        log += chunk;
        const url = /listening at (http:\/\/[^\s]+)/.exec(log)?.[1];
        if (url) started.resolve(url);
        if (log.includes("SEC3 CLI database closed")) disposed.resolve();
      }
    };
    const pumps = [pump(child.stdout), pump(child.stderr)];
    const exited = child.status;
    void exited.then((status) =>
      started.reject(new Error(`CLI exited ${status.code}: ${log}`))
    );
    const peers: InstanceType<typeof Socket>[] = [];
    let origin: string | undefined;
    try {
      origin = (await bounded(started.promise)).replace(/\/$/, "");
      const connect = (headers: Record<string, string>) => {
        const socket = new Socket(
          origin!.replace(/^http/, "ws") + "/api/device",
          { headers },
        );
        peers.push(socket);
        const opened = Promise.withResolvers<number>();
        const snapshot = Promise.withResolvers<Record<string, unknown>>();
        socket.on("open", () => {
          opened.resolve(101);
          socket.send(
            JSON.stringify({
              t: "hello",
              version: "1.0",
              capabilities: ["subscriptions"],
              credentials: { authorization: "Bearer cli" },
            }),
          );
        });
        socket.on("message", (data) => {
          const frame = JSON.parse(String(data));
          if (frame.t === "welcome") {
            socket.send(
              JSON.stringify({
                t: "subscribe",
                channel: "cli",
                generation: 1,
                collection: "note",
                query: { limit: 10 },
              }),
            );
          }
          if (frame.t === "snapshot") snapshot.resolve(frame);
          if (frame.t === "error") {
            snapshot.reject(new Error(JSON.stringify(frame)));
          }
        });
        socket.on("unexpected-response", (_, response) => {
          response.resume();
          opened.resolve(response.statusCode!);
          socket.terminate();
        });
        socket.on("error", () => {});
        return { opened: opened.promise, snapshot: snapshot.promise };
      };
      const rejected = connect({
        origin: "https://foreign.example",
        cookie: "victim=secret",
      });
      assertEquals(await bounded(rejected.opened), 403);
      const admitted = connect({ origin });
      assertEquals(await bounded(admitted.opened), 101);
      const frame = await bounded(admitted.snapshot);
      assertEquals((frame.rows as { id: string }[]).map((row) => row.id), [
        "cli-snapshot",
      ]);
      console.log(
        `Oxian CLI ${transport}: 403 foreign origin; 101 and owner snapshot`,
      );
    } catch (error) {
      console.error(log);
      throw error;
    } finally {
      try {
        await bounded(
          Promise.all(peers.map((peer) => {
            if (peer.readyState === Socket.CLOSED) return Promise.resolve();
            const closed = new Promise<void>((resolve) =>
              peer.once("close", () => resolve())
            );
            if (peer.readyState === Socket.OPEN) {
              peer.close(1000, "Fixture complete");
            } else peer.terminate();
            return closed;
          })),
          5000,
        );
        try {
          child.kill("SIGTERM");
        } catch { /* Exited already. */ }
        await bounded(disposed.promise, 10000);
        // CLI transport checks end after app/database disposal. An outstanding
        // Oxian/Deno process operation is tracked separately in the result file.
        assert(log.includes("SEC3 CLI database closed"));
      } finally {
        try {
          child.kill("SIGKILL");
        } catch { /* Exited already. */ }
        await exited;
        await Promise.all(pumps);
        if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
          const db = await createTestDatabase({
            url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")!,
          });
          await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await db.close();
        }
        await Deno.remove(root, { recursive: true });
      }
    }
  });
}
