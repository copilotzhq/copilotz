# Copilotz Docs

Copilotz is a resource-driven framework. You build apps by declaring resources,
and the runtime composes those resources into agents, persistent state,
execution flows, and application endpoints.

Use this docs tree in three layers:

- [Start Here](./start-here/README.md): learn the core architecture and choose
  the right primitive before you implement anything.
- [Playbooks](./playbooks/README.md): follow task-oriented implementation guides
  for common product workflows.
- [Reference](./reference/README.md): look up exact contracts, handler shapes,
  and API surfaces.

## Suggested Reading Order

1. [What Is Copilotz?](./start-here/what-is-copilotz.md)
2. [Architecture Overview](./start-here/architecture-overview.md)
3. [Resources Are the Foundation](./start-here/resources-are-the-foundation.md)
4. [Choose the Right Primitive](./start-here/choose-the-right-primitive.md)
5. Continue into the relevant [Playbook](./playbooks/README.md)

## Migration from the Legacy Flat Docs

The legacy flat pages in `docs/*.md` remain available during migration. Use the
new nested tree as the canonical structure for new content.

Primary migration targets:

- `overview.md` -> [What Is Copilotz?](./start-here/what-is-copilotz.md) and
  [Architecture Overview](./start-here/architecture-overview.md)
- `resources.md` -> [Resources Are the Foundation](./start-here/resources-are-the-foundation.md)
  and [Resources](./resources/README.md)
- `server.md` -> [App Dispatcher and Endpoints](./runtime/app-dispatcher-and-endpoints.md)
  and [Serve Copilotz with Oxian](./playbooks/serve-copilotz-with-oxian.md)
- `collections.md` -> [Persist Data with Collections](./playbooks/persist-data-with-collections.md)
  and [Collections API](./reference/collections-api.md)
- `events.md` -> [How Events Work](./runtime/how-events-work.md)
- `tools.md` -> [Add Agent Capabilities with Tools](./playbooks/add-agent-capabilities-with-tools.md)
  and [Tools](./resources/tools.md)
- `skills.md` -> [Skills](./resources/skills.md)
- `getting-started.md` -> [Start Here](./start-here/README.md)
- `api-reference.md` -> [Reference](./reference/README.md)

## Public Example Projects

- `copilotz-starter` is the primary public example app for the recommended
  `createCopilotz(...)` + `withApp(...)` + Oxian flow.
- Generic `deno.serve` examples are used only when the docs need to show a
  transport-agnostic integration path.

## Related Pages

- [Start Here](./start-here/README.md)
- [Playbooks](./playbooks/README.md)
- [Resources](./resources/README.md)
- [Runtime](./runtime/README.md)
- [Reference](./reference/README.md)
