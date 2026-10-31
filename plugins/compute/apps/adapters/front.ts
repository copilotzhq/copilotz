/**
 * An app's front, for an image made for it (no Dockerfile of its own): it
 * runs the job's command as its computer did, in the app's folder, and,
 * once the job answers on its port (on this machine: `127.0.0.1` or `::1`,
 * whatever the job bound), passes the platform's port (`PORT`) on to it,
 * WebSockets included. So whatever serves a preview serves the app, bound
 * to localhost or not. The job is given `PORT` as its own port (a job that
 * reads it binds the port it said). The front ends when the job does.
 *
 * Its command and port are files beside it (`command`, `port`), or
 * `CZ_COMMAND` and `CZ_PORT`; its folder is `/app` unless `CZ_CWD`.
 */
export const FRONT = String
  .raw`// An app's front (Copilotz): runs the job's command, passes PORT on to the port it serves.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";

const beside = (name) => readFileSync(new URL(name, import.meta.url), "utf8").trim();
const command = process.env.CZ_COMMAND ?? beside("command");
const target = Number(process.env.CZ_PORT ?? beside("port"));
const port = Number(process.env.PORT || 8080);
const say = (line) => console.error("cz-front: " + line);

const child = spawn("sh", ["-c", command], {
  cwd: process.env.CZ_CWD ?? "/app",
  stdio: "inherit",
  env: { ...process.env, PORT: String(target) },
});
child.on("exit", (code, signal) => {
  say("the app ended (" + (signal ?? code) + ")");
  process.exit(code ?? 1);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));

/** Where the job answers, once it does: IPv4's loopback or IPv6's. */
async function answering() {
  for (const started = Date.now(); Date.now() - started < 240000;) {
    for (const host of ["127.0.0.1", "::1"]) {
      const open = await new Promise((resolve) => {
        const socket = net.connect({ host, port: target }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on("error", () => resolve(false));
      });
      if (open) return host;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("nothing answered on port " + target + " within 4 minutes");
}

const host = await answering().catch((error) => {
  say(error.message);
  child.kill();
  process.exit(1);
});

const server = http.createServer((request, response) => {
  const upstream = http.request(
    { host, port: target, method: request.method, path: request.url, headers: request.headers },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end("The app didn't answer.");
  });
  request.pipe(upstream);
});
server.on("upgrade", (request, socket, head) => {
  const upstream = net.connect({ host, port: target }, () => {
    const lines = [request.method + " " + request.url + " HTTP/" + request.httpVersion];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      lines.push(request.rawHeaders[i] + ": " + request.rawHeaders[i + 1]);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(port, "0.0.0.0", () => say(":" + port + " -> " + host + ":" + target));
`;

/** The port an image's front listens on: 8080, unless the job serves that one. */
export const frontPort = (port: number): number => port === 8080 ? 8081 : 8080;

/**
 * The image made for an app with no Dockerfile of its own: the computer's
 * system (Debian 12) with Node.js 24 and Python, the folder as it was sent,
 * its dependencies installed again (npm, pnpm or yarn; `requirements.txt`)
 * and its `build` script run, as the archive leaves those out; then the
 * front (in `/cz`, with the job's command and port).
 */
export const DOCKERFILE = `FROM mirror.gcr.io/library/node:24-bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates git \\
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
RUN set -e; \\
  if [ -f package.json ]; then \\
    if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then corepack enable && yarn install; \\
    elif [ -f package-lock.json ]; then npm ci; \\
    else npm install; fi; \\
    if node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; then npm run build; fi; \\
  fi; \\
  if [ -f requirements.txt ]; then \\
    python3 -m venv /app/.venv && /app/.venv/bin/pip install --no-cache-dir -r requirements.txt; \\
  fi; \\
  rm -rf /app/.cz
ENV PATH=/app/.venv/bin:/app/node_modules/.bin:$PATH
COPY .cz/ /cz/
CMD ["node", "/cz/front.mjs"]
`;
