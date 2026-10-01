# Understanding Copilotz

Copilotz is a TypeScript framework for building applications with agents, tools
and durable execution history. It combines a generic event runtime with an agent
harness composed from plugins. The harness coordinates conversations, model
calls and tool use; the runtime records what happened and manages the work
triggered by those events.

You can embed one agent in an existing product, build a shared workspace where
people and agents collaborate, or use the runtime for application workflows
without agents. This guide explains how those uses fit together and where to
start.

## What you can build

An agent embedded in a product can use that product's APIs to look up a record,
check its current state or execute an application operation. You define its
role, model connections and allowed tools, then connect the conversation to your
interface or a channel such as WhatsApp.

A shared workspace can include several people and agents in the same thread.
Messages identify their sender and recipients. An agent with a teammate grant
can ask another agent for help, with the exchange recorded in the conversation.
[Agent collaboration](getting-started/part-2-capabilities/09-agent-collaboration.md)
builds this model after the first assistant.

The underlying runtime also accepts application events and runs plugin
processors without a conversation or an LLM. A plugin might react to a domain
event, invoke an action and update durable state. See
[plugins and processors](plugins-and-processors.md) for that path.

## How the pieces fit together

| Part             | Responsibility                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Your application | Supplies the product interface, business rules, identity, access policy and integrations.                                                                          |
| Agent harness    | Uses Core and LLM plugins to coordinate participants, messages, model calls and permitted tools. Optional plugins add channels, skills, memory and other behavior. |
| Runtime          | Persists events and state changes, dispatches processor work, records action lifecycles, and supports observation and recovery.                                    |

Plugins connect the harness to the runtime. The same execution model records a
model call, a tool action or an action in your own workflow. Application
configuration chooses which plugins to install and supplies or overrides
resources and adapters.

The runtime defines five primitives:

| Primitive  | Meaning                                             | Example                                               |
| ---------- | --------------------------------------------------- | ----------------------------------------------------- |
| Collection | Durable application state.                          | A thread or message.                                  |
| Action     | An executable capability with a recorded lifecycle. | A model call or customer lookup.                      |
| Processor  | Behavior triggered by an event.                     | Reacting to a new message.                            |
| Resource   | A process-local definition or policy.               | An agent's role, model choices and capability grants. |
| Adapter    | An interchangeable external implementation.         | A provider implementation or channel integration.     |

You can begin with the supplied harness and ordinary agent and tool definitions.
The [architecture guide](architecture.md) explains the runtime contracts when
you need to write a plugin or change how execution works.

## An agent inside an existing product

Consider a product whose APIs already read records and implement operations. An
embedded agent could handle a user's request through this sequence:

1. The application authenticates the incoming request, selects its namespace and
   routes a message to the agent through a channel or Core input.
2. The harness prepares the conversation and calls one of the agent's configured
   models. The model can select only the tools granted to that agent.
3. A tool invokes the product's existing API or a composed application Action.
   The operation checks business rules and permissions, performs its work and
   returns its result.
4. Copilotz records the action lifecycle and conversation changes. The agent
   uses the tool result to respond through the application's interface or
   channel.
5. The product verifies the resulting state and measures whether the user's
   requested outcome was achieved.

This example uses one agent. Add another agent when the task calls for a
separate specialist, with an explicit grant allowing the first agent to consult
it.

The product's APIs remain responsible for valid transactions. An agent's tool
grant controls which tools it may call; authentication and authorization for the
underlying data and operations belong to your application and services.

## Choosing a starting path

| Your starting point                                            | Read next                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Learn agent composition, tool grants and conversation routing. | [Getting started](getting-started/README.md), beginning with one assistant.                                                                      |
| Embed Copilotz in an existing server or worker.                | [Embedding](embedding-and-hypervisors.md) for the application lifecycle, and [channels](channels.md) for incoming requests and outgoing replies. |
| Serve conversations through HTTP and a browser client.         | [Quickstart](quickstart.md#3-serve-it-over-http) and [server](server.md).                                                                        |
| Connect a product's APIs or an MCP server as tools.            | [OpenAPI tools](../plugins/tool-openapi/README.md), [MCP tools](../plugins/tool-mcp/README.md) and [agent capabilities](agent-capabilities.md).  |
| Add behavior or reuse it across applications.                  | [Plugins and processors](plugins-and-processors.md) and [plugin source layout](plugin-layout.md).                                                |

Start with one representative task and the plugins it needs. Reuse existing
services as tools and decide how Copilotz's conversation state and execution
history fit alongside your product's data. The HTTP facade, chat UI and
additional harness plugins can be added as the application needs them.

## What durability provides

With persistent storage configured, Copilotz keeps conversation state, immutable
events and recorded action results across process restarts. Processor delivery
is at least once; stable operation identities let retries restore settled
results. A tool that changes an external service must also account for retries
at that service, for example through its idempotency support. See
[events, deliveries and recovery](events-deliveries-recovery.md).

Large content can live in a BodyStore, with references held in semantic records.
This lets storage be configured separately from the conversation and action
model. See [content and assets](content-assets.md).

Execution history helps you inspect what an agent did. Your application still
defines task completion, evaluates answer quality and measures outcomes such as
conversion or cost per completed task. Decide whether Copilotz fits by checking
that whole integration, including the work required to learn, extend and operate
it.
