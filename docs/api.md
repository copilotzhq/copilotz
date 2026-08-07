# API and Package Reference

## Application factories

### `createCopilotz(options?)`

Normal factory. Creates a private Ominipg session unless `session` is injected.
Main options:

- `namespace`, `schema`
- `database` or `session` (mutually exclusive)
- `core: false | CopilotzCorePluginOptions`
- `plugins`, `resources`, `pluginResolver`
- `engine.execution` for a shared host or dispatcher/target
- `closeSession` only when ownership of an injected session is intentional

### `createCopilotzApplication(options)`

Embedding factory requiring an explicit `SqlSession`. It composes plugins and
creates the engine but does not infer host/package capabilities.

### `createCopilotzEngine(options)`

Lower-level assembly for applications that already own the event store,
registry, and explicit scope.

## `CopilotzApplication`

Important members:

- `config`, `engine`, `plugins`, `execution`
- `content`, `conversation`, `collections`, `relations`
- `llmAttempts`, `toolExecutions`, `schedules`, `knowledge`
- `events`, `deliveries`
- `run(input)`, `connect(input)`, `goal(input)`
- `recover(options)`, `maintenance(options)`, `shutdown(reason?)`

All products are factory-created frozen records. Infer their type or import
`CopilotzApplication`; do not subclass them.

## Run handle

```ts
type EventNativeRunHandle = {
  eventId: string;
  threadId: string;
  correlationId: string;
  events: ReadableStream<CopilotzEvent>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
};
```

## Attachment

```ts
type ThreadAttachment = {
  id: string;
  namespace: string;
  thread: ConversationThread;
  participant: Participant;
  outputs: ReadableStream<AttachmentOutput>;
  send(input): Promise<AttachmentSendResult>;
  close(reason?: string): Promise<void>;
};
```

## Server

`@copilotz/copilotz/server` exports:

- `createEventNativeApp(application, options?)`
- `createEventNativeFetchHandler(app, options?)`
- `createV1FetchHandler(application, options?)` for transitional clients
- `createV1SseProjector(application, options?)`

The server is a Web Fetch adapter, not a listener or framework.

## Package exports

The authoritative subpath list is `deno.json`. Major groups are application,
engine, plugins, resources, content, domain, events, execution, attachments,
workflows, memory, knowledge, schedules, usage, skills, tools, channels,
features, admin, goals, adapters, server, and the isolated v1 migration.

Every declared subpath is checked independently in CI.
