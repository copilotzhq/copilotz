# Core

## What it is

The semantic plugin for agent Messages, LLM routing, Tools, parallel plans, and
Agent-to-Agent Ask.

## Why it exists

Applications need one durable orchestration layer over provider-neutral LLM and
domain storage primitives.

## How to use it

```ts
import { corePlugin } from "@copilotz/copilotz/core";
// Include corePlugin in the final createCopilotz({ plugins: [...] }) call.
```

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

`@copilotz/copilotz/core/web` is the browser side: chat Collections, intents,
the live thread feed (`threadFeedAdapter`) and the thread, composer, agent
selector and tool Views. The chat shell in `@copilotz/copilotz/ui/web` composes
it; see [Web runtime and Views](../../docs/web-runtime-and-views.md).

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.

## Trusted origin inside a Tool Action

Use `await trustedCoreToolOrigin(context)` once inside the Action to obtain its
trusted thread, agent and participant. It checks the Core cursor against the
owner-retained source event and the claimed durable Tool stage. A
caller-supplied cursor or a different thread is refused. App policy and ingress
metadata can coexist with Core fields; they are excluded from the returned
cursor.

```ts
import { ActionError } from "@copilotz/copilotz/actions";
import { trustedCoreToolOrigin } from "@copilotz/copilotz/core";

const origin = await trustedCoreToolOrigin(context);
if (!origin) throw new ActionError("Tool context unavailable", { status: 403 });
const thread = await context.collections.thread.get({ id: origin.threadId });
const space = thread?.spaceId
  ? await context.collections.space.get({ id: String(thread.spaceId) })
  : undefined;
```

Read Space membership through the app's existing collection policy. The accessor
establishes invocation origin; it does not grant additional collection access.
`coreToolActionMetadata(value)` is a shape parser for lifecycle data, not an
application authorization accessor. Migrate apps that used it to trust arbitrary
`context.action.metadata` to the async accessor above. Keep Core-owned fields
reserved when injecting app metadata.

Atomic message writes retry known optimistic and serialization conflicts after
refreshing membership and recipient reads. A rolled-back attempt retains no
partial message. Refusals and uncertain commits remain failures.
