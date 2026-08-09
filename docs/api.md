# API and Package Reference

## Application factories

### `createCopilotz(options?)`

Normal factory. Creates a private Ominipg session unless `session` is injected.
Main options:

- `namespace`, `schema`
- `database` or `session` (mutually exclusive)
- `core: false | CopilotzCorePluginOptions`
- `plugins`, `resources`, `pluginResolver`
- `toolCatalog` shared by text execution and capability introspection
- `engine.execution` for a shared Hypervisor plus its explicit in-process
  transport, or an already-hosted dispatcher/target
- `closeSession` only when ownership of an injected session is intentional

### `createCopilotzApplication(options)`

Embedding factory requiring an explicit `SqlSession`. It composes plugins and
creates the engine but does not infer host/package capabilities.

### `createCopilotzEngine(options)`

Lower-level assembly for applications that already own the event store,
registry, and explicit scope.

## Skills

`@copilotz/copilotz/skills` exports `defineSkill()`, `defineInlineSkill()`,
`createSkillsPlugin()`, strict `SKILL.md` parsing, and portable skill/file
types. Skills are optional plugins and are not part of the default core catalog
or root runtime barrel, so applications that do not install skills do not bundle
the YAML parser or disclosure tools.

`@copilotz/copilotz/adapters/deno` exports `buildOpenSkillsPlugin()` for the
build-time conversion of standard Agent Skills directories into a portable
plugin. Filesystem directory loading is not an application runtime API. See the
[skills guide](skills.md).

## `CopilotzApplication`

Important members:

- `config`, `engine`, `plugins`, `capabilities`, `execution`
- `content`, `conversation`, `collections`, `relations`
- `llmAttempts`, `toolExecutions`, `schedules`, `knowledge`
- `events`, `deliveries`
- `run(input)`, `connect(input)`, `goal(input)`
- `recover(options)`, `maintenance(options)`, `shutdown(reason?)`

All products are factory-created frozen records. Infer their type or import
`CopilotzApplication`; do not subclass them.

`application.capabilities.resolve({ agent })` returns the agent's effective
tool, peer-agent, and skill resources with plugin origins and grant sources.
Omitted grants resolve to none.

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
engine, capabilities, plugins, resources, content, domain, events, execution,
attachments, workflows, memory, knowledge, schedules, usage, skills, tools,
channels, features, admin, goals, adapters, server, and the isolated v1
migration.

Every declared subpath is checked independently in CI.
