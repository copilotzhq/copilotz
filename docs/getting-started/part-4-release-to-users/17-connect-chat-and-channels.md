---
title: "Chapter 17: Connect Chat and Channels"
description: "Put the assistant behind the authenticated HTTP boundary by adding Core's conversation routes as an opt-in extension, and read replies through the participant-filtered history."
section: Getting Started
order: 170
status: stable
---

# Chapter 17: Connect Chat and Channels

> Part 4 — Release to Users · Track: H · Requires: Chapters 8 and 16 ·
> Recommended: Chapter 9 · Needs: Deno 2.9+ or Node 24+, `OPENAI_API_KEY` for
> the live run

## The pain

`chat.ts` talks to the assistant from inside the host process. It opens the
database, holds the model credential and prints every output it sees. That is
fine for you at a terminal, but a real user is somewhere else: a browser, a
mobile app, a messaging app.

Chapter 16 already gave the Notes application an HTTP boundary with verified
principals, tenant scope and owner-only operations. The assistant is not behind
it. Exposing the agent by hand would mean inventing chat routes, thread lookup
and history reads, and getting their authorization right a second time.

## The problem

A chat boundary needs more than "run the agent":

- **Sending** has to find or create the caller's thread from a stable name, and
  record the message as coming from the authenticated actor, not from whatever
  the request body claims.
- **Reading** has to return only threads the caller takes part in, and only the
  messages that caller may see.
- **Core stays optional.** `server.ts`, `notes-plugin.ts`, `composition.ts` and
  the Chapter 16 tests are generic Runtime code. They must not start importing
  Core, the model credential or live integrations just because one host serves
  chat.

There is also a trap. Owning an operation lets you observe it, and an
operation's raw outputs include everything that ran inside it: model streams,
tool calls and, with Chapter 12's specialists, private Ask answers that the
human is not supposed to see in their history. Operation ownership is not
message visibility.

## The solution

Core ships its HTTP projection as a separate, opt-in plugin. `coreHttpPlugin`
from `@copilotz/copilotz/core/server` contributes:

- the `copilotz.core.conversation.send` Action, registered under the alias
  `sendConversation`, which records the message with the authenticated actor as
  sender. An `externalThreadId` is scoped to that actor, so two users who both
  say `team-notes-chat` get two different threads;
- an HTTP adapter registered as `http.core`, whose read routes are
  `core.threads.list`, `core.threads.get`, `core.threads.messages`,
  `core.threads.message-asset` and `core.threads.observe`. They read through the
  request's authority, so the owner policy decides which threads they see. The
  history route also filters messages for the actor as viewer.

The plan has four parts:

1. `server.ts` stays a generic factory but accepts **extensions**: extra
   plugins, resources, adapters, extra public Action aliases and the host's
   **access** policy. It still imports nothing from Core, and `auth.ts` does not
   change.
2. A new definition module, `chat-access.ts`, extends the Notes policy for chat.
   It binds the `thread` Collection, so every thread read returns only threads
   whose participants include the actor, lets Core's own Actions and Processors
   write threads on the member's behalf, and grants the send Action to every
   member. Raw thread observation stays refused.
3. A new host, `serve-agent.ts` (or `serve-agent-node.ts`), passes Core, the
   agent harness, `coreHttpPlugin` and `chatAccess` into the factory and exposes
   exactly two Actions, by alias: `saveNote` and `sendConversation`.
4. `chat-client.ts` sends a message over HTTP, waits for the operation to
   settle, and prints the reply from the **filtered** thread history.

### Replace `server.ts`

Replace `server.ts` with this complete file. Compared with Chapter 16 it adds
five optional fields to `ServerAppOptions` (`plugins`, `resources`, `adapters`,
`publicActionAliases` and `access`) and merges them into the composition.
Authentication, `principalScope`, `publicActions`, the `member` Collection and
the exposure rules for Collections and Channels are unchanged. Without `access`,
the factory keeps Chapter 16's `notesAccess`. The types come from the factory's
own `CreateCopilotzOptions`, so the factory accepts exactly what
`createCopilotz` accepts and nothing is cast.

```ts
// Runtime factory, its option types and every accepted database choice.
import { createCopilotz } from "@copilotz/copilotz";
import type {
  CopilotzDatabaseInput,
  CreateCopilotzOptions,
} from "@copilotz/copilotz";
// The Fetch boundary: its plugin, the facade declaration and the
// authentication callback type.
import { defineServerFacade, serverPlugin } from "@copilotz/copilotz/server";
import type { ServerAuthenticate } from "@copilotz/copilotz/server";
// Membership, the default policy and the principal-to-scope mapping.
import { member, notesAccess, principalScope } from "./auth.ts";
import type { Access, Principal } from "./auth.ts";
// The reusable Notes package that owns `notes.save`.
import { notesPlugin } from "./notes-plugin.ts";

// Hosts and tests keep importing the principal type from here.
export type { Principal } from "./auth.ts";

// Host-supplied verification. It returns the trusted principal, or
// `undefined` when the request carries no acceptable credential.
export type ResolvePrincipal = (
  request: Request,
) => Principal | undefined | Promise<Principal | undefined>;

// The extension shapes `createCopilotz` itself accepts.
type ApplicationPlugins = NonNullable<CreateCopilotzOptions["plugins"]>;
type ApplicationResources = NonNullable<CreateCopilotzOptions["resources"]>;
type ApplicationAdapters = NonNullable<CreateCopilotzOptions["adapters"]>;

// Choices only the host can make. Nothing here has a persistent default.
export type ServerAppOptions = Readonly<{
  // Verifies each request. Required, so no facade is ever built without it.
  resolvePrincipal: ResolvePrincipal;
  // Default namespace for the application. Defaults to `team-notes`.
  namespace?: string;
  // Database chosen by the host. Omit it for a private in-memory database.
  database?: CopilotzDatabaseInput;
  // Extra plugins composed after the Notes package and the facade.
  plugins?: ApplicationPlugins;
  // Extra resources, such as agents and model connections.
  resources?: ApplicationResources;
  // Extra adapters, such as a scripted model in a test.
  adapters?: ApplicationAdapters;
  // Extra Action aliases to publish, on top of `publicActions`.
  publicActionAliases?: readonly string[];
  // The host's policy. Defaults to `notesAccess` from `auth.ts`.
  access?: Access;
}>;

// The only Action aliases the facade publishes by default. Adding a plugin does
// not add routes until its Action's alias is listed here or in
// `publicActionAliases`.
export const publicActions = ["saveNote"];

// Plugins the server application composes: the Notes package and the facade.
export const serverPlugins = [notesPlugin, serverPlugin];

// Builds the Notes application with its HTTP boundary. The returned app's
// `fetch` method is the handler a host serves.
export function createServerApp(options: ServerAppOptions) {
  // One policy for every request this application serves.
  const access = options.access ?? notesAccess;

  // Turns the host's principal into the facade's trusted scope, or rejects.
  const authenticate: ServerAuthenticate = async (request, context) => {
    const principal = await options.resolvePrincipal(request);
    // No verified principal: refuse before any route runs.
    if (!principal) {
      return Response.json(
        {
          error: { code: "unauthorized", message: "Authentication required." },
        },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }
    // Tenant, schema, actor and authority come only from the principal.
    return principalScope(principal, context, access.policy);
  };

  return createCopilotz({
    // The application's default tenant, chosen by the host.
    namespace: options.namespace ?? "team-notes",
    // Pass the host's database through only when it chose one.
    ...(options.database ? { database: options.database } : {}),
    // The Notes package and the facade first, then the host's extensions.
    plugins: [...serverPlugins, ...(options.plugins ?? [])],
    // Host adapters, only when the host supplied some.
    ...(options.adapters ? { adapters: options.adapters } : {}),
    // Policy data: the owner reads it, the facade never exposes it.
    collections: { member },
    // Evaluated by the owner inside every command a request starts.
    authorization: access.authorization,
    resources: {
      // Host resources, such as `agents` and `llmConnections`.
      ...options.resources,
      server: {
        // The facade served at `/api`.
        default: defineServerFacade({
          // Explicit allowlist. Without it, every Action, Collection read and
          // Channel would be exposed.
          expose: {
            actions: {
              include: [
                ...publicActions,
                ...(options.publicActionAliases ?? []),
              ],
            },
            // Notes and memberships stay off raw Collection routes.
            collections: false,
            // This application publishes no Channels.
            channels: false,
          },
          // Runs for every matched facade route, including fixed routes.
          authenticate,
        }),
      },
    },
  });
}
```

`expose` only covers Action, Collection and Channel families. Routes that a
plugin contributes through an HTTP adapter, like Core's thread reads, are
mounted whenever the plugin is composed. That is why the next step matters:
those routes read Collections, and the policy decides what each read returns.

### Create `chat-access.ts`

`chat-access.ts` is a **definition module**. It keeps Chapter 16's rules,
membership from the `member` source, `saveNote` for editors and owner-only
operations, and adds the chat rules. It names Core's aliases as plain strings,
so it imports nothing from Core, and its revision is `3` because it grants more
than revision `2`.

```ts
// Type of one constraint set the policy returns.
import type { ServerConstraints } from "@copilotz/copilotz";
// The shape `server.ts` accepts as a host's policy.
import type { Access } from "./auth.ts";

// The Notes policy, extended for chat. A new revision, because it grants more.
const chatPolicy = { id: "notes", revision: "3" } as const;

// Owner-evaluated authorization for the chat host. It names Core's aliases as
// plain strings, so this module imports nothing from Core.
export const chatAccess: Access = {
  policy: chatPolicy,
  authorization: {
    policies: {
      [chatPolicy.id]: {
        revision: chatPolicy.revision,
        // The only data this policy may read.
        sources: ["member"],
        async evaluate(
          { authority, intent, read },
        ): Promise<ServerConstraints> {
          const actorId = authority.principal.id;
          // Membership in the request's tenant, read inside the command.
          const [membership] = await read.list("member", {
            where: { actorId },
            limit: 1,
          });
          // Not a member of this tenant: nothing is granted.
          if (!membership) return {};
          const roles = membership.roles as string[];
          // Operations stay readable only by the actor who started them.
          const ownOperations = {
            operations: { metadata: { initiatorUserId: actorId } },
          };
          // A thread is visible only to its participants. Core uses the
          // authenticated actor's ID as that actor's participant ID.
          const memberThreads = {
            thread: { contains: { participantIds: [actorId] } },
          };

          switch (intent.kind) {
            case "action":
              // Every member may chat; only editors may save notes, whether
              // they call `notes.save` or the assistant calls it for them.
              return {
                ...ownOperations,
                actions: {
                  sendConversation: {},
                  ...(roles.includes("editor") ? { saveNote: {} } : {}),
                },
              };
            case "collection":
              // Core's own Actions and Processors create threads, enroll
              // participants and record each message as the thread's activity
              // on the member's behalf. Direct reads, such as the thread
              // routes, get the membership filter and nothing else.
              return intent.invocation
                ? {
                  collections: memberThreads,
                  collectionMutations: {
                    thread: {
                      create: {},
                      update: {},
                      commands: { ensureMembership: {}, recordMessage: {} },
                    },
                  },
                }
                : { collections: memberThreads };
            default:
              // Operation reads and observation. No thread filter here, so raw
              // thread observation, which carries private answers, is refused.
              return ownOperations;
          }
        },
      },
    },
    // Bindings, keyed by alias: the two published Actions and the thread
    // Collection that Core's read routes go through.
    actions: { saveNote: chatPolicy, sendConversation: chatPolicy },
    collections: { thread: chatPolicy },
  },
};
```

Three details are deliberate:

- **The `thread` binding is what keeps conversations private.** Core's read
  routes call ordinary Collection reads. Without a binding, those reads would be
  unfiltered, and every member of the tenant could list every thread. With it,
  the owner adds the membership filter to each read, before pagination, and
  `core.threads.get` and `core.threads.messages` answer `404` for a thread the
  actor is not in.
- **`intent.invocation` separates Core's work from the caller.** Creating a
  thread, enrolling participants, recording replies and marking each message as
  the thread's latest activity happen inside Core's Actions and Processors,
  which run with the member's retained authority. The owner tells the policy
  which Action, Processor or alarm is executing, so the policy can grant those
  writes there and nowhere else. A direct call has no invocation and gets only
  the read filter.
- **The assistant acts with the member's authority.** When the assistant calls
  `saveNote`, the owner evaluates the same policy for that member. A member
  without the `editor` role can chat, but the policy refuses the assistant's
  `saveNote` call, nothing is saved, and the turn's operation fails.

Observation intents get only the operation-ownership constraint and no thread
filter, so `core.threads.observe` answers `403`, and
`core.threads.message-asset` stays closed because the policy grants no
`assets.read`. The send Action also rejects a `threadId` the actor is not a
member of.

### Create `serve-agent.ts`

`serve-agent.ts` is a Deno **host entrypoint** next to `serve.ts`. It and its
Node alternative, `serve-agent-node.ts`, are the only new modules that import
`agent.ts`, so only these two hosts read `OPENAI_API_KEY` and evaluate any live
integrations you added in Chapters 9 to 13. The generic server, auth and runtime
modules and the client do not. It passes the same host choices from
`composition.ts` as `app.ts` does. That only means shared state with Chapter 7's
persistent database: with the `:memory:` database, each process has its own
data, and notes, threads and idempotency keys end when the host shuts down. With
a local file database, do not run another app process against it while this
server owns it.

The local identity is the same loopback development user as Chapter 16, and the
host grants it the `editor` role, so the assistant may save notes for it. Every
member may chat under `chatAccess`. A production host keeps its own
`resolvePrincipal` from Chapter 16 and manages memberships from its own
administration flow.

```ts
// Core's optional HTTP projection: the send Action and the `http.core` adapter.
import { coreHttpPlugin } from "@copilotz/copilotz/core/server";
// Host composition: Core, tools, the model connection and the assistant. This
// import reads the credential.
import { agentPlugins, agentResources } from "./agent.ts";
// The same host choices as `app.ts`.
import { database, namespace, runtimePlugins } from "./composition.ts";
// The pure server definition and its principal type.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";
// The chat host's policy, and the host helper that writes memberships.
import { chatAccess } from "./chat-access.ts";
import { grantRoles } from "./auth.ts";

// Local demo credential: a fixed string checked by exact match.
const devAuthorization = "Bearer local-dev-token";

// The same local demo identity as Chapter 16.
const localUser: Principal = { actorId: "local-guide-user", namespace };

const app = await createServerApp({
  // Exact match only; any other or missing header resolves to no principal.
  resolvePrincipal: (request) =>
    request.headers.get("authorization") === devAuthorization
      ? localUser
      : undefined,
  namespace,
  database,
  // Runtime plugins, the agent harness, then Core's HTTP projection. Shared
  // plugin objects are registered once.
  plugins: [...runtimePlugins, ...agentPlugins, coreHttpPlugin],
  // Agents, model connections and tools that Core reads.
  resources: agentResources,
  // Publish the send Action. Update, delete and edit stay unpublished.
  publicActionAliases: ["sendConversation"],
  // The policy that also covers chat.
  access: chatAccess,
});

// Set once the listener starts, so a signal can shut it down gracefully.
let server: Deno.HttpServer | undefined;
const stop = () => void server?.shutdown();

try {
  // The local demo identity may save notes, directly or through the
  // assistant. Every member may chat.
  await grantRoles(app, localUser.actorId, ["editor"]);

  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);

  server = Deno.serve({
    // Accept loopback connections only.
    hostname: "127.0.0.1",
    port: 8000,
    onListen: ({ hostname, port }) =>
      console.log(`Notes chat API on http://${hostname}:${port}/api`),
  }, app.fetch);

  // Resolves after `shutdown()` has let pending requests finish.
  await server.finished;
  console.log("listener stopped");
} finally {
  // Always remove the handlers and release the database, even after a
  // startup failure.
  Deno.removeSignalListener("SIGINT", stop);
  Deno.removeSignalListener("SIGTERM", stop);
  await app.close();
}
```

`coreHttpPlugin` registers its adapter under the name `http.core` itself, so the
host does not register `coreHttpAdapter` again. The adapter export exists for
applications that compose Core HTTP routes into their own plugin.

### Create `serve-agent-node.ts`

On Node, use this entrypoint instead. It needs `@hono/node-server`, which you
installed in Chapter 15.

```ts
// Bridges a Node HTTP listener to a Fetch handler.
import { serve } from "@hono/node-server";
// Shutdown signals.
import process from "node:process";
// Core's optional HTTP projection: the send Action and the `http.core` adapter.
import { coreHttpPlugin } from "@copilotz/copilotz/core/server";
// Host composition: Core, tools, the model connection and the assistant. This
// import reads the credential.
import { agentPlugins, agentResources } from "./agent.ts";
// The same host choices as `app.ts`.
import { database, namespace, runtimePlugins } from "./composition.ts";
// The pure server definition and its principal type.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";
// The chat host's policy, and the host helper that writes memberships.
import { chatAccess } from "./chat-access.ts";
import { grantRoles } from "./auth.ts";

// Local demo credential: a fixed string checked by exact match.
const devAuthorization = "Bearer local-dev-token";

// The same local demo identity as Chapter 16.
const localUser: Principal = { actorId: "local-guide-user", namespace };

const app = await createServerApp({
  // Exact match only; any other or missing header resolves to no principal.
  resolvePrincipal: (request) =>
    request.headers.get("authorization") === devAuthorization
      ? localUser
      : undefined,
  namespace,
  database,
  // Runtime plugins, the agent harness, then Core's HTTP projection.
  plugins: [...runtimePlugins, ...agentPlugins, coreHttpPlugin],
  // Agents, model connections and tools that Core reads.
  resources: agentResources,
  // Publish the send Action. Update, delete and edit stay unpublished.
  publicActionAliases: ["sendConversation"],
  // The policy that also covers chat.
  access: chatAccess,
});

// Set by the listener lifecycle below; the `finally` block removes them.
let stop = () => {};
let fail = (_error: Error) => {};
let server: ReturnType<typeof serve> | undefined;

try {
  // The local demo identity may save notes, directly or through the
  // assistant. Every member may chat.
  await grantRoles(app, localUser.actorId, ["editor"]);

  // Accepts loopback connections and forwards every request to `app.fetch`.
  const listener = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: 8000 },
    (info) =>
      console.log(`Notes chat API on http://127.0.0.1:${info.port}/api`),
  );
  server = listener;

  // Resolves once a signal has closed the listener; rejects on a listener
  // failure, such as the port being in use.
  await new Promise<void>((resolve, reject) => {
    stop = () => listener.close((error) => (error ? reject(error) : resolve()));
    fail = reject;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    listener.on("error", fail);
  });
  console.log("listener stopped");
} finally {
  // Always remove the handlers and release the database.
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  server?.off("error", fail);
  await app.close();
}
```

Both hosts listen on port 8000, like `serve.ts`, so run one at a time.

### Create `chat-client.ts`

`chat-client.ts` is the caller's **entrypoint**. It imports only the public
clients, `@copilotz/copilotz/client` and `@copilotz/copilotz/core/client`, which
are browser-safe. It never imports `agent.ts`, `server.ts` or a credential
module. It takes the prompt and an idempotency key from the command line, for
the same reason as `call-notes.ts`: one key per logical message, reused on
retry.

The flow:

1. `core.threads.send` submits the message to the actor's `team-notes-chat`
   thread and returns an operation receipt.
2. `client.operations.observe` follows the work this operation carries,
   including the assistant's turn; detached background work settles separately.
   The script reads only output descriptor types: the operation's terminal
   descriptor (`operation.settled` with an `outcome` of `completed`, `failed` or
   `cancelled`) and `llm.call.failed`. A well-formed observation can end without
   a terminal descriptor, so the script treats that as a premature end, not
   success. And as in Chapter 8, an operation can complete even though the model
   call failed, so completion alone does not prove the assistant replied.
3. `client.operations.result` returns `{ value, seq }`, where `value` is the
   send Action's `{ threadId, message }` output. That result is available as
   soon as the message is recorded; it does not wait for the assistant's turn.
   The script uses it only for `threadId`, after step 2 saw the operation
   settle.
4. `core.threads.messages` reads the thread history, filtered for this actor,
   and the script prints the latest visible messages from it.

```ts
// The public HTTP client, its error type and the observation error type.
import {
  CopilotzHttpError,
  createCopilotzClient,
  ProtocolError,
} from "@copilotz/copilotz/client";
// Typed conversation API over the generic client.
import { createCoreClient } from "@copilotz/copilotz/core/client";
// Command-line input and the exit status.
import process from "node:process";

// The same loopback development credential as `call-notes.ts`. A browser app
// gets its credential from your sign-in, never from a constant.
const client = createCopilotzClient({
  baseUrl: "http://127.0.0.1:8000/api",
  getRequestHeaders: () => ({ authorization: "Bearer local-dev-token" }),
});
const core = createCoreClient(client);

// Sends one message and prints the reply. Returns the process exit status.
async function chat(prompt: string, idempotencyKey: string): Promise<number> {
  // Submit the message. Retrying with the same key and prompt returns the
  // same operation instead of sending the message twice.
  const receipt = await core.threads.send({
    // Stable thread name, scoped to the authenticated actor by the server.
    externalThreadId: "team-notes-chat",
    content: prompt,
    // The agent that should reply.
    recipientIds: ["assistant"],
  }, { idempotencyKey });
  console.log(`operation ${receipt.operationId}`);

  // Follow the whole operation. Only output descriptor types are read; stream
  // bytes and Event fields are not printed.
  let terminal: string | undefined;
  let modelCallFailed = false;
  try {
    await client.operations.observe({
      operationIds: [receipt.operationId],
      onFrame(frame) {
        if (frame.kind !== "output") return;
        const { type } = frame.output;
        // The operation's terminal state, after the work it carries, including
        // the assistant's turn. Detached background work settles separately.
        if (
          type === "operation.settled"
        ) {
          terminal = String(frame.output.outcome);
        }
        // A model call that ended in failure. Keep consuming frames.
        if (type === "llm.call.failed") modelCallFailed = true;
      },
    });
  } catch (error) {
    // The observation could not complete, for example a broken connection or
    // a malformed frame. The operation may still be running on the server.
    if (error instanceof ProtocolError) {
      console.error("observation could not complete; rerun with the same key");
      return 1;
    }
    throw error;
  }

  // The observation ended cleanly but never reported a terminal state, so
  // nothing is known about the assistant's turn.
  if (!terminal) {
    console.error("observation ended early; rerun with the same key");
    return 1;
  }
  // The operation failed or was cancelled.
  if (terminal !== "completed") {
    console.error(`operation ended: ${terminal}`);
    return 1;
  }

  // The send Action's own output. Only `threadId` is used; the operation has
  // already settled above.
  let threadId: string;
  try {
    const result = (await client.operations.result(receipt.operationId))
      .value as {
        threadId: string;
      };
    threadId = result.threadId;
  } catch (error) {
    if (error instanceof CopilotzHttpError) {
      console.error(`result unavailable: HTTP ${error.status}`);
      return 1;
    }
    throw error;
  }

  // Read a bounded page of the latest messages from the filtered history: only
  // messages this actor may see, newest first, then print them oldest first.
  const page = await core.threads.messages(threadId, {
    order: "desc",
    limit: 4,
  });
  for (const message of [...page.data].reverse()) {
    const text = message.content
      .flatMap((part) => (part.kind === "text" ? [part.value] : []))
      .join("");
    const { participantType, externalId } = message.sender;
    console.log(`${participantType} ${externalId}: ${text}`);
  }

  // The operation completed, but the model call inside it failed.
  if (modelCallFailed) {
    console.error("the assistant could not reply: model call failed");
    return 1;
  }
  return 0;
}

// The prompt and the idempotency key for this one message.
const [prompt, idempotencyKey] = process.argv.slice(2);
if (!prompt || !idempotencyKey) {
  console.error('Usage: chat-client.ts "<prompt>" <idempotency-key>');
  process.exitCode = 2;
} else {
  process.exitCode = await chat(prompt, idempotencyKey);
}
```

The history read is the part a user-facing view should copy. The raw observation
in step 2 is a different matter, explained next.

### What operation ownership does not hide

`client.operations.observe` sends **all** of the operation's outputs to its
owner over the network, including model stream bytes and, with Chapter 12's
reviewer, the private Ask answer. The script above ignores those bytes, but
ignoring them in JavaScript is not a confidentiality boundary: they have already
reached the client. Chapter 16's ownership check decides **whose** operation you
may observe, not **which** outputs inside it you may see.

`core.threads.messages` is different. It filters history for the actor as
viewer, so the private Ask answer is not in it, while the assistant's final
public reply is.

So treat the observation in `chat-client.ts` as a **trusted diagnostic**: fine
for the operator's own CLI, whose user may inspect every operation internal. For
end-user views:

- display replies from `core.threads.messages`, not from raw observation;
- if users must never receive private agent data, do not grant them raw
  observation: return no `operations` constraint for `observation` intents, as
  `chatAccess` already does for threads by returning no thread filter, or build
  your own server-side filtered observation. Hiding it in the browser is not
  enough.

### Browsers and Channels

A browser app uses the same two imports as `chat-client.ts`. Serve its assets
from your host however you already do; any Asset route the UI needs goes through
the same `chatAccess` policy, which grants no Asset reads until you add an
`assets.read` grant. Never bundle `agent.ts`, `composition.ts` or anything that
reads a credential.

Channels such as Web, WhatsApp or Telegram are **provider ingress and egress
adapters**. They turn a provider's webhook into the same Core thread operations
and send replies back out. They are not a second conversation store, and
`createCoreClient` does not configure them for you. Each provider needs its own
credentials and webhook verification on the host before any code runs, and this
chapter keeps `channels: false`. The [Channels reference](../../channels.md)
covers channel adapters and sessions, including the difference between asking
for durable cancellation of a superseded turn and merely detaching an observer.

## Check it works

The live run calls your model provider, so it needs `OPENAI_API_KEY` set in the
host's environment, as in Chapter 8.

Start the chat host with Deno:

```sh
# -A: listener, database files and the credential variable.
deno run -A serve-agent.ts
# Node 24+ alternative:
node serve-agent-node.ts
```

In a second terminal, send a message:

```sh
# Deno client: network access to the loopback host only.
deno run --allow-net=127.0.0.1:8000 chat-client.ts "Save a note: ship chat." chat-017
# Node 24+ alternative, same arguments.
node chat-client.ts "Save a note: ship chat." chat-017
```

Expected facts, not exact text:

- an `operation …` line, then the script exits with status 0: the operation
  reached `operation.settled` and no `llm.call.failed` was observed;
- the script prints a bounded page of the latest messages visible to
  `local-guide-user` on its `team-notes-chat` thread, ending with the
  assistant's reply. With Chapter 9's tool or Chapter 12's specialist, extra
  messages can push your prompt off that page. If the assistant chose to call
  `saveNote`, a note is saved too; the model decides that, not the client;
- running the same command again with the same key returns the same operation
  and does not add a second message.

A nonzero exit status means the operation failed or was cancelled, the model
call failed, or the observation ended before reporting a terminal state.
Rerunning with the same key follows the same operation again.

The thread belongs to `local-guide-user`. A different principal, even in the
same tenant, does not see it in `core.threads.list`, and gets `404` from
`core.threads.get` and `core.threads.messages` for its ID. The Chapter 16
`server.test.ts` and `server.node-test.ts` run unchanged, on a private in-memory
database, with no Core and no credential.

Stop the host with Ctrl+C.

## What this unlocks

- The assistant is reachable over HTTP behind the same verified principals,
  tenant scope and owner-only operations as `notes.save`, and it acts with each
  member's own authority.
- Core is opt-in per host: `server.ts` stays generic, and only `serve-agent.ts`
  brings in Core, the model credential and live integrations.
- Each user gets their own thread for the same external name, and history reads
  are filtered for the viewer.
- New Core Actions stay closed until you publish them and the policy grants
  them, and Core's read routes see only what the policy's filters allow.

## Next steps

- Next (Runtime track):
  [Chapter 18: Handle Files and Large Content](18-handle-files-and-large-content.md)
  adds file bodies and scoped Asset references.
- Optional, requires this chapter:
  [Chapter 20: Measure Usage](../part-5-operate-and-scale/20-measure-usage.md)
  records model usage per tenant on this host.
- Reference: [Owner authorization](../../authorization.md) covers bindings,
  `intent.invocation` and every constraint.
- Reference: [HTTP server and browser client](../../server.md) covers adapter
  routes and endpoint kinds.
- Reference: [Channels](../../channels.md) and
  [Multi-agent Ask](../../multi-agent-ask.md) cover provider adapters and
  private specialist answers.
