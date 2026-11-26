/**
 * The model providers that run on a person's plan, through its CLI on a
 * computer of theirs (see shared/engines.ts): `claude-plan` (Claude Code),
 * `codex-plan` (Codex, on a ChatGPT plan), `gemini-plan` (Antigravity, on a
 * Google AI plan), `grok-plan` (Grok Build) and `cursor-plan` (Cursor's SDK,
 * on a Cursor plan). Each person signs the CLI in once, on their own
 * computer; their agents' calls then run there, in any conversation.
 *
 * Each is a plan (`harness`): a model list given a person's plans runs its
 * maker's models on it first (Claude Code 10, Codex 30 after ChatGPT on the
 * server, Grok Build 40, Antigravity 50; Cursor 60, every maker's), and
 * `computer.connected` says who has it. Antigravity, Grok Build and Cursor
 * list the models their plan runs, by their own names, and a list runs on
 * them by it (see the models plugin's plans.ts): their `serves` map counts
 * only until their computer has said it. Claude Code and Codex list none:
 * they run their maker's models by the API's names.
 *
 * An agent may also name one first and an API model next, for when it can't
 * run (no computer of theirs on, not signed in, the plan's limit reached, a
 * routine with no one there): `["claude-plan/claude-opus-5-5",
 * "anthropic/claude-opus-5-5"]`. Its uses are metered, tagged
 * `paid: "subscription"`, at no cost to the app (`engineCost`).
 */
import type { Harness, Provider } from "../../../models/contract.ts";

/**
 * A plan's provider, on `engine`, its models found in `catalog`'s; a plan
 * (`harness`) that serves `serves`, at `order` among a person's plans.
 */
const plan = (
  engine: string,
  catalog: string | false,
  title: string,
  note: string,
  harness: Harness,
): Provider => ({
  title,
  note,
  adapter: "engine",
  catalog,
  options: { engine },
  tags: { paid: "subscription" },
  // A CLI starting, signing in again or loading a long session can be quiet a while.
  silence: 5 * 60_000,
  harness,
});

export const engineProviders: Record<string, Provider> = {
  "claude-plan": plan(
    "claude",
    "anthropic",
    "Claude plan",
    "Runs on the Claude plan of whoever asks, through Claude Code on their own computer: each person signs in once.",
    { order: 10, serves: { "anthropic/*": "*" }, plan: "Claude" },
  ),
  "codex-plan": plan(
    "codex",
    "openai",
    "ChatGPT plan, through Codex",
    "Runs on the ChatGPT plan of whoever asks, through Codex on their own computer: each person signs in once.",
    // After ChatGPT on the server (the accounts plugin's `chatgpt`, 20).
    { order: 30, serves: { "openai/*": "*" }, plan: "ChatGPT" },
  ),
  "gemini-plan": plan(
    "antigravity",
    false,
    "Google AI plan, through Antigravity",
    "Runs on the Google AI plan of whoever asks, through Antigravity on their own computer: each person signs in once.",
    // Until its computer says its list: Google's models by the same names.
    { order: 50, serves: { "google/*": "*" }, plan: "Google AI" },
  ),
  "grok-plan": plan(
    "grok",
    "xai",
    "Grok plan",
    "Runs on the Grok plan of whoever asks, through Grok Build on their own computer: each person signs in once.",
    { order: 40, serves: { "xai/*": "*" }, plan: "Grok" },
  ),
  "cursor-plan": plan(
    "cursor",
    false,
    "Cursor plan",
    "Runs on the Cursor plan of whoever asks, through Cursor's SDK on their own computer: each person signs in once.",
    // Until its computer says its list: the makers' models by the same names. Its own
    // (`composer-2.5`) by name.
    {
      order: 60,
      plan: "Cursor",
      serves: { "anthropic/*": "*", "openai/*": "*", "google/*": "*", "xai/*": "*" },
    },
  ),
};

/** What their uses cost the app: nothing (the person's plan pays). */
export const engineCost = {
  "claude-plan/*": { input: 0, output: 0 },
  "codex-plan/*": { input: 0, output: 0 },
  "gemini-plan/*": { input: 0, output: 0 },
  "grok-plan/*": { input: 0, output: 0 },
  "cursor-plan/*": { input: 0, output: 0 },
};
