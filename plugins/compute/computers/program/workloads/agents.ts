/**
 * Engines: agents' model calls on the plans' CLIs this computer has (see
 * agents/). Which it has and whether each is signed in
 * (`computer.agents.status`); signing one in (`computer.agents.login`); one
 * step of a model call, its events streamed as JSON lines
 * (`computer.agents.prompt`); and stopping one (`computer.agents.cancel`).
 */
import type { WorkerWorkHandler } from "@oxian/oxian-js";
import type { CancelInput, LoginInput, PromptInput, StatusInput } from "../../shared/workloads.ts";
import { createSessions } from "../agents/acp.ts";
import { createEngines } from "../agents/engines.ts";
import { answer, fail } from "./answer.ts";

export type AgentsOptions = {
  /** Each engine's CLI, by name: found unless given; null for none. */
  commands?: Record<string, string | null>;
  /** A session with no prompt this long closes. */
  idleMs?: number;
  /** A prompt nobody came back to this long goes, with its session. */
  heldMs?: number;
  /** The most a prompt's events not yet received may be. */
  maxBuffer?: number;
  /** How long after a step's first call others still join it. */
  stepMs?: number;
};

/** The engines' work, for the computer at `root`. */
export function createAgents(
  root: string,
  log: (line: string) => void,
  options: AgentsOptions = {},
) {
  const engines = createEngines({ root, commands: options.commands, log });
  const sessions = createSessions({ engines, log, ...options });

  const prompt: WorkerWorkHandler = async ({ input, signal }) => {
    let value: PromptInput;
    try {
      const text = await new Response(input).text();
      value = (text ? JSON.parse(text) : {}) as PromptInput;
    } catch {
      value = undefined as unknown as PromptInput;
    }
    return sessions.prompt(value, signal);
  };

  return {
    status: answer((input: StatusInput) => {
      const names = input?.engines;
      if (
        names !== undefined && !(Array.isArray(names) && names.every((n) => typeof n === "string"))
      ) {
        fail("engines is a list of names");
      }
      return engines.status(names);
    }),
    login: answer((input: LoginInput) => engines.login(input)),
    prompt,
    cancel: answer((input: CancelInput) => {
      if (typeof input?.session !== "string" || !input.session) fail("session is required");
      sessions.cancel(input.session);
      return { ok: true };
    }),
    /** Every session and sign-in stops. */
    stop: () => Promise.allSettled([sessions.stop(), engines.stop()]).then(() => {}),
  };
}
