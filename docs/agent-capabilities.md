# Agent Capabilities

Installing a plugin resource and authorizing an agent to use it are separate
operations. Copilotz uses explicit least-authority grants; an omitted grant
never inherits everything currently installed.

| Layer              | Contract                                          |
| ------------------ | ------------------------------------------------- |
| Plugin registry    | The resource exists in this application or worker |
| Agent capabilities | This agent may use the resource                   |
| Introspection      | Adapters can report the effective, resolved grant |

```ts
type AgentCapabilitySelection = readonly string[];

type AgentCapabilities = {
  tools?: AgentCapabilitySelection;
  agents?: AgentCapabilitySelection;
  skills?: AgentCapabilitySelection;
};
```

An omitted `capabilities` object or omitted key means none. An array is an exact
alias grant and preserves its declared order:

```ts
const agent = {
  id: "support",
  name: "Support",
  role: "Resolve customer issues.",
  capabilities: {
    tools: ["lookup_customer"],
    agents: ["billing-specialist"],
    skills: ["triage"],
  },
};
```

Unknown aliases fail during capability resolution. Adding another plugin
therefore never silently expands an existing Agent.

## Derived framework mechanisms

`agents` and `skills` are domain capabilities, not plumbing details:

- Granting at least one agent derives the installed `ask` tool.
- Granting a skill derives `list_skills` and `load_skill`.
- An installed `read_skill_resource` tool is also derived; it is required when
  any granted skill has supporting files.

The required plugin must still be installed. `corePlugin` contributes the native
`ask` Action and its Tool Resource; a Skills plugin contributes its disclosure
Actions and Tool Resources. If a higher-level grant lacks a required mechanism,
resolution fails with a bounded configuration error.

The generic runtime installs no semantic plugins implicitly. Applications
compose `corePlugin` and any native tools, web tools, finance, memory, usage,
schedules, knowledge, or skills explicitly.

## Canonical resolution

Core resolves static, OpenAPI-generated, and MCP-generated Tool Resources from
the composed registry. Each selected Resource names the same alias in the
composed Action map, and Core invokes that Action directly. There is no second
Tool catalog or execution registry.

Core’s default capability Resource resolves grants from the current context:

```ts
import { agentCapabilities } from "@copilotz/copilotz/core";

const view = agentCapabilities.resolve({ agent: "support" }, context);

view.tools; // alias, data-only Resource, and explicit/derived grant
view.agents;
view.skills;
```

Core's resolved Skill resource contract intentionally contains only the stable
`name` needed for grant resolution. Skill descriptions, file descriptors, and
`read` belong to the Skills plugin's resource and context APIs; consumers that
need those fields should use the Skills-owned surface after the grant has been
resolved.

The public application does not expose its registry. A trusted embedding that
already owns composition may back the portable CLI's `inspect` callback with the
same resolver so its `/tools`, `/agents`, and `/skills` views cannot drift:

```ts
startInteractiveCli({
  application: { send: app.send, namespace: "acme" },
  scope,
  inspect,
});
```

The terminal adapter supplies only host I/O. It does not add a Tool catalog or a
second execution path.
