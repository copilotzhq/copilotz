/**
 * The Cursor runner: what the computer program runs, with Node, to reach a
 * person's Cursor plan. Cursor has no CLI to drive, only its SDK
 * (`@cursor/sdk`, some 21 MB with platform binaries), which the program
 * doesn't carry: Sign in installs it into the engine's home, and the program
 * writes this script beside it (`runner.mjs`), as text. It's plain
 * JavaScript, so Node runs it as it is.
 *
 * Run with a word, it's a CLI of its own: `version` (the SDK's), `status`
 * (`{ signedIn, account?, models? }`: its sign-in read from its home, and the
 * models Cursor lists for the account, left out when Cursor can't be asked),
 * `login` (Cursor's own sign-in: a link, and it waits until it's done there;
 * nothing goes back to it) and `logout`. The sign-in is a user API key kept
 * in its home (`auth.json`, only its user reads it), apart from the person's
 * own Cursor.
 *
 * Run with none, it's an ACP agent on its stdin and stdout, as Antigravity
 * is: a session is a Cursor local agent (`Agent.create`, then
 * `Agent.resume`), with none of Cursor's tools but MCP's (`tools: ["mcp"]`),
 * reaching only the session's MCP server (the agent's tools), and the
 * session's folder its workspace. Cursor's prompt can't be replaced on most
 * plans: the agent's instructions go on top of it, as the folder's one
 * project rule (`.cursor/rules/agent.mdc`, always applied). A prompt is a
 * run: its text and thinking stream as ACP updates, and it answers with
 * what it used. A failure says why (`data.code`: `signed_out`, `limit`,
 * `model`, `failed`).
 */
export const CURSOR_RUNNER = String
  .raw`// Copilotz's Cursor runner (written by the computer program: don't edit it).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Agent, Cursor, FileCredentialStore } from "@cursor/sdk";

const store = new FileCredentialStore(new URL("./auth.json", import.meta.url).pathname);
const mode = process.argv[2];

if (mode === "version") {
  const sdk = new URL("./node_modules/@cursor/sdk/package.json", import.meta.url);
  console.log(JSON.parse(await readFile(sdk, "utf8")).version);
  process.exit(0);
}
if (mode === "status") {
  const said = await Cursor.auth.status({ store });
  const signedIn = said.status === "logged-in";
  // The models the plan runs, as Cursor lists them for its account: none when it can't be asked.
  const listed = async () =>
    (await Cursor.models.list({ apiKey: (await store.load()).apiKey })).map((m) => m.id);
  const late = () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 10000));
  const models = signedIn ? await Promise.race([listed(), late()]).catch(() => undefined) : undefined;
  console.log(JSON.stringify({
    signedIn,
    ...(signedIn && said.email ? { account: said.email } : {}),
    ...(models?.length ? { models } : {}),
  }));
  process.exit(0);
}
if (mode === "login") {
  await Cursor.auth.login({
    store,
    apiKeyName: "Copilotz",
    onLoginUrl: (url) => console.log("Sign in to Cursor here: " + url),
  });
  console.log("Signed in to Cursor.");
  process.exit(0);
}
if (mode === "logout") {
  await Cursor.auth.logout({ store });
  process.exit(0);
}

/** Why a run failed, from what Cursor said. */
const codeOf = (text) =>
  /unauthenticated|unauthori[sz]ed|api key|not (signed|logged) in|log ?in again/i.test(text)
    ? "signed_out"
    : /rate.?limit|usage limit|limit reached|quota|too many requests|exceeded/i.test(text)
    ? "limit"
    : /model/i.test(text) && /not|invalid|unknown|unavailable|unsupported/i.test(text)
    ? "model"
    : "failed";
const failure = (message, code = codeOf(message)) => Object.assign(new Error(message), { code });

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });

/** Each session's agent, and the run under way. */
const sessions = new Map();

/** A session's agent: a new one, or (id) the one it was, taken up again. */
async function open(params, id) {
  const meta = params?._meta?.copilotz ?? {};
  if (typeof meta.instructions !== "string" || typeof meta.model !== "string") {
    throw failure("_meta.copilotz needs the instructions and model", "failed");
  }
  const signedIn = await store.load();
  if (!signedIn) throw failure("Cursor isn't signed in on this computer", "signed_out");
  // The agent's instructions, over Cursor's own prompt: the folder's one rule, always applied.
  const rules = join(params.cwd, ".cursor", "rules");
  await mkdir(rules, { recursive: true });
  await writeFile(join(rules, "agent.mdc"), "---\nalwaysApply: true\n---\n" + meta.instructions + "\n");
  const mcpServers = Object.fromEntries(
    (params.mcpServers ?? []).filter((s) => s?.type === "http").map((s) => [s.name, {
      type: "http",
      url: s.url,
      headers: Object.fromEntries((s.headers ?? []).map((h) => [h.name, h.value])),
    }]),
  );
  const options = {
    apiKey: signedIn.apiKey,
    model: { id: meta.model },
    tools: ["mcp"],
    mcpServers,
    local: { cwd: params.cwd, settingSources: ["project"] },
  };
  try {
    const agent = id ? await Agent.resume(id, options) : await Agent.create(options);
    sessions.set(agent.agentId, { agent });
    return agent.agentId;
  } catch (error) {
    throw failure(String(error?.message ?? error));
  }
}

/** A prompt: one run, streamed. */
async function prompt(params) {
  const session = sessions.get(params?.sessionId);
  if (!session) throw failure("No session " + params?.sessionId, "failed");
  if (session.run) throw failure("A prompt is running in this session", "failed");
  const text = (params.prompt ?? []).flatMap((block) =>
    block?.type === "text"
      ? [String(block.text ?? "")]
      : block?.type === "resource" && typeof block.resource?.text === "string"
      ? [block.resource.text]
      : []
  ).join("\n\n");
  // A prompt's images go with its words (the SDK's SDKUserMessage).
  const images = (params.prompt ?? []).flatMap((block) =>
    block?.type === "image" && block.data
      ? [{ data: String(block.data), mimeType: String(block.mimeType ?? "image/png") }]
      : []
  );
  try {
    session.run = await session.agent.send(images.length ? { text, images } : text);
    for await (const message of session.run.stream()) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            update(params.sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: block.text },
            });
          }
        }
      } else if (message.type === "thinking" && message.text) {
        update(params.sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: message.text },
        });
      }
    }
    const done = await session.run.wait();
    if (done.status === "cancelled") return { stopReason: "cancelled" };
    if (done.status !== "finished") throw failure(done.error?.message ?? "Cursor's run failed");
    const used = done.usage;
    return {
      stopReason: "end_turn",
      ...(used
        ? {
          _meta: {
            copilotz: {
              usage: {
                input: used.inputTokens + used.cacheReadTokens + used.cacheWriteTokens,
                output: used.outputTokens,
                ...(used.cacheReadTokens ? { cached: used.cacheReadTokens } : {}),
                ...(used.cacheWriteTokens ? { cacheWrite: used.cacheWriteTokens } : {}),
              },
            },
          },
        }
        : {}),
    };
  } catch (error) {
    throw error?.code ? error : failure(String(error?.message ?? error));
  } finally {
    session.run = undefined;
  }
}

const methods = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true },
      promptCapabilities: { image: true, embeddedContext: true },
    },
    authMethods: [],
  }),
  "session/new": async (params) => ({ sessionId: await open(params) }),
  "session/load": async (params) => {
    if (!sessions.has(params?.sessionId)) await open(params, String(params?.sessionId ?? ""));
    return {};
  },
  "session/prompt": prompt,
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "session/cancel") {
    return void sessions.get(message.params?.sessionId)?.run?.cancel().catch(() => {});
  }
  if (message.id === undefined || !message.method) return;
  const run = methods[message.method];
  if (!run) {
    return send({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
  try {
    send({ id: message.id, result: await run(message.params) });
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message, data: { code: error.code } } });
  }
}).on("close", () => process.exit(0));
`;
