# Convention-first support agent

Run `deno task smoke:authoring` from the repository root. The build discovers
the source entries and emits `dist/plugin.js`; `run.ts` imports that bundle and
verifies a streamed reply from a Core Agent using an injected deterministic LLM
Adapter. No external service or credentials are needed.

For standalone package consumption, follow the
[authoring guide](../../docs/convention-authoring.md#runnable-agent-example).
The guide includes all package import mappings and build/run commands.
