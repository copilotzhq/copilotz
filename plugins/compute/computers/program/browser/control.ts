/**
 * Who drives who's browser: an agent for one batch at a time, or a person
 * who took control (in the live view) until they hand it back.
 */
import { browserError, deadline, delay } from "./async.ts";

export type Control = {
  /** The viewer in control, if a person is. */
  human?: string;
  /** Whether an agent's batch is running. */
  agent: boolean;
  readonly changes: Set<() => void>;
  state(): { controller: "human" | "agent"; viewerId?: string; busy: boolean };
  take(viewer: string): void;
  release(viewer: string): void;
  assertHuman(viewer: string): void;
  /** Waits up to `ms` for a person to hand back control; answers how to let it go. */
  acquireAgent(ms: number, signal: AbortSignal): Promise<() => void>;
};

export function createControl(): Control {
  const control: Control = {
    agent: false,
    changes: new Set(),
    state: () => ({
      controller: control.human ? "human" : "agent",
      viewerId: control.human,
      busy: control.agent,
    }),
    take(viewer) {
      if (control.agent || (control.human && control.human !== viewer)) {
        throw browserError("busy", "Another controller is using the browser");
      }
      control.human = viewer;
      changed();
    },
    release(viewer) {
      if (control.human !== viewer) return;
      control.human = undefined;
      changed();
    },
    assertHuman(viewer) {
      if (control.human !== viewer || control.agent) {
        throw browserError("not_controller", "Take control before sending browser input");
      }
    },
    async acquireAgent(ms, signal) {
      const limit = deadline(ms, signal);
      try {
        while (control.human || control.agent) {
          try {
            await delay(25, limit.signal);
          } catch (error) {
            if (!signal.aborted && control.human) {
              throw browserError(
                "human_in_control",
                "A person controls this browser; they need to hand it back first",
              );
            }
            throw error;
          }
        }
        signal.throwIfAborted();
        control.agent = true;
        changed();
        return () => {
          control.agent = false;
          changed();
        };
      } finally {
        limit.dispose();
      }
    },
  };
  const changed = () => {
    for (const fn of control.changes) fn();
  };
  return control;
}
