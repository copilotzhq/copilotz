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
 * server, Grok Build 40, Antigravity 50; Cursor 60, every maker's it names),
 * and `computer.connected` says who has it. An agent may also name one first and an API model next, for when
 * it can't run (no computer of theirs on, not signed in, the plan's limit
 * reached, a routine with no one there): `["claude-plan/claude-opus-5-5",
 * "anthropic/claude-opus-5-5"]`. Its uses are metered, tagged
 * `paid: "subscription"`, at no cost to the app (`engineCost`).
 */
import type { Harness, Provider } from "../../../models/contract.ts";

/** Models a plan runs by the same names as their maker's API: `"<maker>/<model>": "*"`. */
const same = (maker: string, models: string[]) =>
  Object.fromEntries(models.map((model) => [`${maker}/${model}`, "*"]));

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
    // Google's models by the same names; others it runs once their names are checked.
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
    // The makers' models Cursor runs, by the same names (its list, 2026-11-25); its own (`composer-2.5`) by name.
    {
      order: 60,
      plan: "Cursor",
      serves: {
        ...same("anthropic", [
          "claude-opus-5-5",
          "claude-sonnet-5-5",
          "claude-haiku-5-5",
          "claude-fable-5-2",
          "claude-opus-5",
          "claude-sonnet-5",
        ]),
        ...same("openai", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]),
        ...same("google", [
          "gemini-4-neon",
          "gemini-4-carbon",
          "gemini-4-hydrogen",
          "gemini-4-argon",
          "gemini-3.8-flash",
        ]),
        ...same("xai", ["grok-4.7", "grok-4.6", "grok-4.5"]),
      },
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
