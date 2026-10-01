---
title: "Ch 12: Interfaces and Channels"
description: "Choose a local interactive interface or add a durable Channel for a host transport."
section: Getting Started
order: 120
status: stable
---

# Chapter 12: Interfaces and Channels

## The pain

An application with an Action or Agent still needs an interface. A terminal
loop, a browser chat, and a provider webhook have different input and output
needs. Treating each interface as a new application can duplicate routing and
conversation policy.

## The solution

Use Core's HTTP integration with a React chat adapter for a browser interface,
Core's Node terminal Adapter for local development, or a Channel plugin for a
host transport that needs durable ingress. Each path reaches the same
application runtime.

### Serve Core conversations

The generic Action server from Chapter 11 does not include Core conversation
routes. Extend its root-level `server.ts` with the Core harness, Core HTTP
adapter, and Agent declaration from Chapter 1. This keeps the Notes Action and
the Chapter 11 host authentication resolver in one Fetch boundary.
`coreHttpPlugin` depends on the same `corePlugin` object, so the registry
composes Core once.

Add these imports in `server.ts`, keeping its existing imports for
`createCopilotz`, `defineServerFacade`, `serverPlugin`, and `notesPlugin`:

```ts
// Read the model credential from the server's process environment.
import { env } from "node:process";
// Import the Core harness that supplies the agent and conversation resources.
import { corePlugin } from "@copilotz/copilotz/core";
// Import Core's optional Thread/history HTTP adapter.
import { coreHttpPlugin } from "@copilotz/copilotz/core/server";
```

Replace the existing `plugins` property in `createCopilotz()` with:

```ts
// Compose Core, its HTTP adapter, the Notes Action, and the Server facade.
plugins: [corePlugin, coreHttpPlugin, notesPlugin, serverPlugin],
```

Inside the existing `resources` object, add these Resource properties beside
`server`. This repeats Chapter 1's model choice; the provider is called only
when the browser sends a conversation turn.

```ts
// Reuse the provider connection name selected by the Chapter 1 Agent.
llmConnections: {
  // Register the named connection used by this server-side Agent.
  openai: {
    // Select the provider adapter for the model connection.
    provider: "openai",
    // Read the credential from host configuration rather than source code.
    auth: { apiKey: env.OPENAI_API_KEY! },
  },
},
// Declare the Agent that receives browser messages.
agents: {
  // Match the stable recipient ID used by the typed Core client below.
  assistant: {
    // Give the Agent its durable routing identity.
    id: "assistant",
    // Set the name shown in conversation history and the chat UI.
    name: "Notes assistant",
    // Describe its purpose without moving application rules into the prompt.
    role: "A helpful assistant for capturing and finding notes.",
    // Point to the provider connection instead of repeating credentials.
    models: {
      // List the available model choices for text generation.
      generate: [{
        // Refer to the connection declared above.
        connection: "openai",
        // Select the text-generation model.
        model: "gpt-5.4-mini",
      }],
    },
    // Preserve the Tool grant created in the earlier Notes chapter.
    capabilities: { tools: ["saveNote"] },
  },
},
```

The Core HTTP adapter routes are added by the Adapter, but its conversation
Actions remain subject to the Server Action allowlist. In the existing
`resources.server.default` facade, replace the `expose` property and add
`authorize` beside the existing `authenticate` callback:

```ts
// Expose Notes and Core conversation Actions through explicit patterns.
expose: {
  // The Server matcher supports the Core conversation prefix wildcard.
  actions: { include: ["notes.save", "copilotz.core.conversation.*"] },
  // Keep generic Collection endpoints disabled for this UI.
  collections: false,
  // Keep Channel ingress disabled until one is added later in this chapter.
  channels: false,
},
// Authorize only the existing Notes Action and the four Core UI mutations.
authorize(_request, { endpoint }) {
  // Track the public Core Conversation Actions the typed client may submit.
  const allowedActions = new Set([
    // Preserve the existing note-saving workflow.
    "notes.save",
    // Accept a new Core message.
    "copilotz.core.conversation.send",
    // Permit Thread rename and status changes exposed by the chat controls.
    "copilotz.core.conversation.update",
    // Permit Thread deletion when the chat control is enabled.
    "copilotz.core.conversation.delete",
    // Permit message edits when the chat control is enabled.
    "copilotz.core.conversation.edit-message",
  ]);
  // Deny other Action routes even if a future plugin adds them.
  if (endpoint.kind === "action" && !allowedActions.has(endpoint.id)) {
    return new Response("Action is not allowed.", { status: 403 });
  }
  // The Core HTTP read adapter independently enforces Thread membership.
  return {};
},
```

Keep the Chapter 11 authenticated `authenticate` callback. The sample
`authorize` allows every authenticated caller to use the listed operations;
replace its allowlist with your host's role and record-ownership rules before
sharing the interface. The actor ID returned by authentication must be stable
and consistent with Core participant identity. The
[HTTP server reference](../../server.md) lists the Core routes and policy
contract.

### Put the conversation in a React interface

Install the optional React packages at versions compatible with the Copilotz
release used by the server. The two UI packages are separate from the generic
runtime and are not needed for a CLI or custom Fetch interface.

```sh
# Install the Copilotz React adapter and UI plus the application's React peers.
npm install @copilotz/chat-adapter @copilotz/chat-ui react react-dom
```

Create `NotesChat.tsx` in the React application. The imports and component props
below match the published `CopilotzChat` interface. This same-origin example
lets the browser send the host's existing session cookie; use
`getRequestHeaders` when your authentication design requires custom headers.

```tsx
// Import the ready-to-use Copilotz chat controller and presentation component.
import { CopilotzChat } from "@copilotz/chat-adapter";
// Load the shared UI styles once from the presentation package.
import "@copilotz/chat-ui/styles.css";
// Import the generic Fetch client and typed Core conversation wrapper.
import { createCopilotzClient } from "@copilotz/copilotz/client";
import { createCoreClient } from "@copilotz/copilotz/core/client";

// Create the browser-safe HTTP client for the authenticated same-origin facade.
const httpClient = createCopilotzClient({
  // Target the Server facade mounted by the host at /api.
  baseUrl: "/api",
});

// Add Core's concrete Threads and messages to the generic HTTP client.
const coreClient = createCoreClient(httpClient);

// Render the complete chat interface against the authenticated Core routes.
export function NotesChat() {
  // Return the adapter component with the host identity and shared Core client.
  return (
    <CopilotzChat
      // Use a stable host user ID for local UI state, not as server authority.
      userId="signed-in-user"
      // Show the human-readable name in the conversation interface.
      userName="Alex"
      // Reuse the exact typed client configured above for this component lifetime.
      coreClient={coreClient}
    />
  );
}
```

For a one-off application send outside the component, call the typed Core
client. `participantIds` enrolls the selected Agent in a new room, while
`recipientIds` selects who answers this message; for a new one-Agent room they
can be the same list.

```ts
// Start a typed conversation using the same client exposed to the React view.
const receipt = await coreClient.threads.send(
  {
    // Let Core create or reuse a room using this stable external host identity.
    externalThreadId: "notes-browser-demo",
    // Provide the human-readable content for this conversation turn.
    content: "Save a note that the release review is on Friday.",
    // Enroll the existing Agent as a participant in the new room.
    participantIds: ["assistant"],
    // Address only the Agent that should respond to this message.
    recipientIds: ["assistant"],
  },
  {
    // Persist this key if the host may retry the same logical submission.
    idempotencyKey: crypto.randomUUID(),
  },
);

// Read the operation result after the server has accepted the conversation turn.
const result = await coreClient.operations.result(receipt.operationId);
```

### Replace the one-shot message with a local terminal

This is an exact patch to the Chapter 1 `assistant.ts`. Add the Node adapter
import with the existing imports:

```ts
// Import the Node-owned readline implementation for the interactive CLI.
import { startInteractiveCli } from "@copilotz/copilotz/core/cli/node";
```

Replace the existing `try` body that sends one message and drains its output
with this block. Keep the surrounding `finally { await app.close(); }` from
Chapter 1.

```ts
// Start a terminal loop that sends every prompt through the existing Core app.
const cli = startInteractiveCli({
  // Reuse the app so the interface does not duplicate runtime composition.
  application: app,
  // Bind all prompts to one stable conversation and human identity.
  scope: {
    // Reuse this Thread across terminal prompts and process restarts.
    thread: { externalId: "notes-cli" },
    // Keep the local user's conversation identity stable.
    participant: { externalId: "you", participantType: "human" },
    // Address the already-declared Agent for every terminal input.
    recipientIds: ["assistant"],
  },
});

// Wait until the user enters /exit or the terminal closes.
await cli.closed;
```

The Node adapter owns `node:readline/promises`; the generic CLI state machine
does not import terminal APIs. Browser interfaces use the Core HTTP adapter and
typed client shown above; the generic Action client in
[Chapter 11](11-http-and-client.md) is sufficient for application Actions but
does not add conversation routes by itself.

### Add a Web Channel when the host needs Channel ingress

The first-party Web Channel turns a typed request into a durable Channel
occurrence. Add its import and plugin to the existing `server.ts` composition;
the Chapter 11 Server facade and authenticated Fetch host remain the ingress
boundary.

```ts
// Import the first-party request-observed Web Channel plugin.
import { webChannelPlugin } from "@copilotz/copilotz/channels";
```

Replace the existing `plugins` property after the Core HTTP setup with:

```ts
// Add Web ingress to the existing Core, Notes, and Server composition.
plugins: [corePlugin, coreHttpPlugin, notesPlugin, serverPlugin, webChannelPlugin],
```

The `plugins` line replaces the existing composition property. If you applied
Chapter 10, keep `memoryPlugin` in the list; retain the exact `corePlugin`
object too, which the plugin registry deduplicates. In the Chapter 11 facade,
replace `channels: false` with:

```ts
// Allow only the Web Channel alias through the existing authenticated facade.
channels: { include: ["web"] },
```

Keep the host's real `authenticate` policy so the Web adapter receives a trusted
actor.

The Web Channel input is deliberately small. Add this call beside the typed
client's existing Action call in `call-notes.ts`:

```ts
// Submit one human message through the Web Channel's typed ingress contract.
const receipt = await client.channels.submit(
  // Address the Channel alias installed by webChannelPlugin.
  "web",
  {
    // Choose a stable application-owned identity for the conversation.
    externalThreadId: "notes-web-demo",
    // Send the user-visible message content through Channel ingress.
    content: "Save a note that the release review is on Friday.",
    // Address only the Agent that should answer this message.
    recipientIds: ["assistant"],
  },
  {
    // Persist this key with the host request if it may retry after a lost reply.
    idempotencyKey: crypto.randomUUID(),
  },
);

// Keep the durable receipt so the UI can observe or inspect the operation.
console.log(receipt.operationId);
```

`client.channels.submit()` uses the same idempotent operation protocol as an
Action submission. Configure the facade to expose this Channel, and let the
host's identity and authorization policy decide which users can submit. Other
Channel plugins—such as Discord, Telegram, WhatsApp, or Zendesk—have their own
Adapter and provider setup. Follow the provider-specific chapter before enabling
one; credentials and webhook verification belong to the host.

## Breaking it down

The terminal Adapter renders normal Core streams and sends typed Core messages.
The Web Channel instead converts a host request to a Channel occurrence, then
durable ingress routes it through the application's existing processing
pipeline. Neither is a replacement runtime, and neither makes a Tool grant for
an Agent.

Request-observed egress is useful when the submitter needs to observe its
operation. Other Channel policies can retain different delivery requirements. Do
not treat an external provider's delivery acknowledgement as proof that an Agent
operation completed; observe the operation when the interface needs its result.

## What this unlocks

- Developers can test a full turn in a local terminal.
- A Web client can submit a durable request without calling Agent internals.
- Provider Channels can be added only when their ingress, egress, and host
  requirements are understood.

## What's next

Messages and Tool outputs can carry large or binary bodies, while accounting
needs more than a guess at provider cost.
[Chapter 13: Content and Usage](13-content-and-usage.md) shows the Asset
boundary and optional usage ledger.
