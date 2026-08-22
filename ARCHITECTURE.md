# Copilotz Architecture — 30,000-Foot View

Copilotz is an event-driven runtime for building AI harnesses from small, composable primitives. Rather than embedding agent behavior, model providers, tools, and application state into a single execution loop, the runtime separates them into independent components that communicate through events and well-defined runtime interfaces.

At the center of the architecture is the **runtime**. The runtime owns the event lifecycle, maintains the registries contributed by plugins, exposes shared runtime context, and coordinates execution. Applications send inputs into the runtime; those inputs cause state changes or actions to execute, which in turn produce events. Events become the common language through which the rest of the system observes what has happened and decides what should happen next.

The runtime is extended through **plugins**. A plugin is a package of capabilities that contributes some combination of five primitives:

* **Collections** represent state and provide the operations for mutating and querying that state.
* **Actions** represent executable application capabilities or workflows. They contain the reusable logic for performing an operation and emit lifecycle events as they execute.
* **Processors** react to events and implement orchestration and business logic by deciding which actions or mutations should happen next.
* **Resources** are named, declarative definitions and configuration consumed by the runtime and its plugins, such as agents, tools, models, prompts, or routing policies.
* **Adapters** provide interchangeable implementations for variable external or infrastructural boundaries, such as different LLM providers, storage systems, search engines, or execution environments.

These primitives deliberately operate at different levels of abstraction. **Collections describe what is**, **actions describe what the system can do**, and **processors decide when those capabilities should be used**. Resources provide the configuration that influences those decisions, while adapters isolate the parts of an implementation that may vary depending on the external system being used.

Events connect these components without requiring them to know about one another directly. A collection mutation can emit lifecycle events such as created, updated, or deleted. An action can emit events describing invocation, progress, completion, failure, or cancellation. Processors subscribe to relevant events and can respond by invoking another action or mutating another collection. More complex behavior therefore emerges as a sequence of small event-driven transitions rather than from one monolithic control loop.

An AI harness is built on top of these generic primitives rather than being hard-coded into the runtime. Messages, threads, participants, and execution records can be represented as collections. LLM calls, tool invocations, or other capabilities can be actions. The agent loop itself is expressed through processors that react to conversation and execution events and determine the next operation to perform.

Concepts such as **agents**, **tools**, and **models** primarily enter the system as resources. An agent resource can describe its identity, instructions, model preferences, available tools, and policies. A tool resource can describe how an existing action should be exposed to an LLM. A model resource can describe which model and adapter should be used for an LLM operation. These definitions remain declarative; the actual behavior comes from actions and processors.

Provider-specific behavior is isolated behind adapters. For example, an `llm.call` action may own the common workflow for preparing an LLM request, consuming a streamed response, normalizing its output, and integrating the result into the runtime. The portions that differ between OpenAI, Google, or another provider are delegated to their respective LLM adapters. Consequently, the orchestration and business logic remains unchanged when the underlying provider changes.

The runtime acts as the **composition boundary** for all of this. When plugins are installed, their collections, actions, processors, resources, and adapters are registered with the runtime. Resources and adapters remain separate composition categories: resources are available under `context.resources`, while adapters are available under `context.adapters`. Actions and processors declare ordinary TypeScript interfaces for the context shape they expect. These interfaces provide type inference and static composition checking; they do not become runtime dependency declarations. The runtime passes the complete composed context without filtering it or constructing per-capability proxies.

Plain typed objects are the canonical way to declare resources and adapters. Semantic plugins may export optional helpers such as `defineAgent`, `defineModel`, or provider-adapter factories when those helpers add useful inference, defaults, normalization, or runtime validation. A helper must not create a privileged object form: an equivalent plain object satisfying the same public interface remains valid. Dynamic configuration is validated by the semantic plugin that understands it, not by the generic runtime.

Both actions and processors may consume the composed resources and adapters through their declared context interfaces. Their architectural roles still guide usage: actions normally use adapters to implement capabilities, while processors normally consume resources, invoke actions, and mutate collections. Calling an external adapter directly from a processor is possible but should prompt the author to consider whether that operation belongs in an action so it receives the normal action lifecycle, retry identity, and durable input/output.

The reference AI harness follows the same composition rules. The minimal Core plugin owns conversation state, agent resources, ingress helpers, and the processors that implement the agent loop. Core depends on the first-party LLM plugin through ordinary plugin composition. The LLM plugin owns the common `llm.call` action, model-resource contract, LLM-adapter contract, and first-party provider adapter factories. Applications choose and configure provider adapters explicitly. Memory, knowledge, schedules, channels, concrete tools, goals, usage accounting, and admin behavior remain optional first-party plugins rather than hidden Core behavior.

At a high level, the architecture can therefore be thought of as:

```text
                         Plugins
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
      Resources         Processors         Collections
          │                 │                 │
          │ configures      │ reacts to      │ represents
          ▼                 ▼                 ▼
                        Runtime / Events
                              │
                              │ invokes
                              ▼
                           Actions
                              │
                              │ uses variable boundaries
                              ▼
                           Adapters
                              │
                              ▼
                     External Systems
```

The resulting architecture keeps the runtime intentionally general. Copilotz itself provides the execution model and composition mechanisms; AI-specific concepts emerge from plugins built on top of those primitives. This allows the same runtime to support different agent architectures, model providers, tool ecosystems, persistence strategies, and orchestration patterns without coupling the core to any one of them.

The core conceptual model is:

**Events describe what happened. Collections describe what is. Processors decide what happens next. Actions implement what can be done. Resources describe how the system should be configured. Adapters determine how interchangeable external boundaries are implemented. Plugins compose these pieces into higher-level behavior.**
