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
type CapabilitySelection =
  | readonly string[]
  | { all: true; except?: readonly string[] };

type AgentCapabilities = {
  tools?: CapabilitySelection;
  agents?: CapabilitySelection;
  skills?: CapabilitySelection;
};
```

An omitted `capabilities` object or omitted key means none. An array is an exact
stable-ID grant and preserves its declared order. Broad access must be explicit:

```ts
const agent = {
  id: "support",
  name: "Support",
  role: "Resolve customer issues.",
  capabilities: {
    tools: ["lookup_customer"],
    agents: ["billing-specialist"],
    skills: { all: true, except: ["internal-release"] },
  },
};
```

Unknown IDs fail during capability resolution. Adding another plugin therefore
does not silently expand an existing agent unless that agent deliberately uses
`{ all: true }`.

## Derived framework mechanisms

`agents` and `skills` are domain capabilities, not plumbing details:

- Granting at least one agent derives the installed `ask` tool.
- Granting a skill derives `list_skills` and `load_skill`.
- An installed `read_skill_resource` tool is also derived; it is required when
  any granted skill has supporting files.

The required plugin must still be installed. For example, enable the built-in
ask plugin with `core: { ask: {} }`, and install skills through a skills plugin.
If a higher-level grant lacks its mechanism resource, resolution fails with a
bounded configuration error.

Copilotz enables only the provider and text workflow plugins by default. Native
tools, web tools, finance, memory, usage, public ask, schedules, knowledge, and
skills are explicit opt-ins.

## Canonical introspection

The application resolves static, OpenAPI-generated, and MCP-generated tools
through the same worker-local catalog used for prompting and execution:

```ts
const view = await app.capabilities.resolve({ agent: "support" });

view.tools; // resource, stable ID, plugin origin, explicit/all/derived grant
view.agents;
view.skills;
```

Pass an application-wide `toolCatalog` when generated tools need a runtime
adapter. The text workflow and `app.capabilities` then share that exact catalog.

The Node-compatible terminal adapter consumes this introspection directly:

```ts
startInteractiveCli({
  application: app,
  agent: "support",
  scope,
});
```

`/tools`, `/agents`, and `/skills` cannot drift from the effective agent grant.
The lower-level portable CLI remains available with injected `performRun` and
`inspect` callbacks for remote clients.
