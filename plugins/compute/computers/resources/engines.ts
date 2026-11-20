/**
 * The model providers that run on a person's plan, through its CLI on a
 * computer of theirs (see shared/engines.ts): `claude-plan` (Claude Code),
 * `codex-plan` (Codex, on a ChatGPT plan) and `gemini-plan` (Antigravity,
 * on a Google AI plan). Each person signs the CLI in once, on their own
 * computer; their agents' calls then run there, in any conversation.
 *
 * An agent names one first and an API model next, for when it can't run
 * (no computer of theirs on, not signed in, the plan's limit reached, a
 * routine with no one there): `["claude-plan/claude-opus-5-5",
 * "anthropic/claude-opus-5-5"]`. Its uses are metered, tagged
 * `paid: "subscription"`, at no cost to the app (`engineCost`).
 */
import type { Provider } from "../../../models/contract.ts";

/** A plan's provider, on `engine`, its models found in `catalog`'s. */
const plan = (engine: string, catalog: string | false, title: string, note: string): Provider => ({
  title,
  note,
  adapter: "engine",
  catalog,
  options: { engine },
  tags: { paid: "subscription" },
  // A CLI starting, signing in again or loading a long session can be quiet a while.
  silence: 5 * 60_000,
});

export const engineProviders: Record<string, Provider> = {
  "claude-plan": plan(
    "claude",
    "anthropic",
    "Claude plan",
    "Runs on the Claude plan of whoever asks, through Claude Code on their own computer: each person signs in once.",
  ),
  "codex-plan": plan(
    "codex",
    "openai",
    "ChatGPT plan, through Codex",
    "Runs on the ChatGPT plan of whoever asks, through Codex on their own computer: each person signs in once.",
  ),
  "gemini-plan": plan(
    "antigravity",
    false,
    "Google AI plan, through Antigravity",
    "Runs on the Google AI plan of whoever asks, through Antigravity on their own computer: each person signs in once.",
  ),
};

/** What their uses cost the app: nothing (the person's plan pays). */
export const engineCost = {
  "claude-plan/*": { input: 0, output: 0 },
  "codex-plan/*": { input: 0, output: 0 },
  "gemini-plan/*": { input: 0, output: 0 },
};
