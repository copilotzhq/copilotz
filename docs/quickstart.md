# Quickstart

The [Getting started guide](getting-started.md) grows one assistant into an
application, introducing one useful change at a time. Its examples explain the
important declarations and configuration properties in code comments.

Use Deno 2.9+ or Node 24+. Follow the
[project setup](getting-started.md#before-you-start), then choose a step below.
The model examples require a provider credential; the runtime-only examples work
without a model.

## 1. Run your first assistant

[Hello Agent](getting-started/part-1-foundations/01-hello-agent.md) is a
complete Core-only program. Configure one assistant, send with
`app.send(message(...))`, read its reply and close the application. A thread
object creates or reuses the conversation, so you do not need a channel plugin
for the first message.

## 2. Give an agent a tool

[Your First Tool](getting-started/part-1-foundations/02-your-first-tool.md) adds
one native capability and its explicit grant. Then
[Application Data and Actions](getting-started/part-1-foundations/03-application-data-and-actions.md)
implements a shared note-saving operation: the same application Action can serve
an agent, a workflow or an HTTP caller.

[Processors and Lifecycles](getting-started/part-1-foundations/04-processors-and-lifecycles.md)
shows how a committed change triggers more work and produces inspectable
history.
[Reusable Plugins](getting-started/part-1-foundations/05-reusable-plugins.md)
packages that behavior for other applications.

## 3. Serve it over HTTP

[HTTP and Client](getting-started/part-3-production/11-http-and-client.md)
exposes an application Action through the Server plugin and calls it with the
typed client. It introduces authentication, allowed routes and authorization
before accepting callers. The [server reference](server.md) covers the full
policy surface.

## 4. Put a chat UI on it

[Interfaces and Channels](getting-started/part-3-production/12-interfaces-and-channels.md)
connects the conversation API to an interface and explains when to use channel
plugins. Add
[Agent Collaboration](getting-started/part-2-capabilities/09-agent-collaboration.md)
when a task benefits from a separate specialist.

## 5. Keep your data

[Persistence and Recovery](getting-started/part-1-foundations/06-persistence-and-recovery.md)
replaces the default in-memory database with persistent storage and explains
at-least-once delivery. Choose the deployment's data scope in
[Tenants and Access](getting-started/part-3-production/14-tenants-and-access.md),
then decide where execution runs in
[Deployment and Next Steps](getting-started/part-3-production/15-deployment-and-next-steps.md).

## Add only what the task needs

- [Existing APIs and Tools](getting-started/part-2-capabilities/07-existing-apis-and-tools.md)
  for native declarations, OpenAPI and MCP.
- [Skills](getting-started/part-2-capabilities/08-skills.md) for reusable
  instructions loaded when needed.
- [Memory and Knowledge](getting-started/part-2-capabilities/10-memory-and-knowledge.md)
  for context beyond the current conversation.
- [Content and Usage](getting-started/part-3-production/13-content-and-usage.md)
  for large bodies and metered model work.

Return to the [documentation index](README.md) for reference guides.
