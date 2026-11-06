/**
 * Boards' and cards' fields as the Actions take them (JSON Schema), and
 * what's kept of what's given: names and titles trimmed, labels trimmed and
 * once each, due dates real days. Who did something, as documents say it
 * (`person:ana`, `agent:north`), and new documents' ids: short, so agents
 * and links carry them easily.
 */
import type { Actor } from "../../../../runtime/mod.ts";
import { invalid } from "./errors.ts";

export const LIMITS = {
  name: 80,
  description: 20_000,
  title: 300,
  labels: 12,
  label: 32,
  column: 40,
};

export const NAME = { type: "string", minLength: 1, maxLength: LIMITS.name } as const;
export const TITLE = { type: "string", minLength: 1, maxLength: LIMITS.title } as const;
export const DESCRIPTION = { type: "string", maxLength: LIMITS.description } as const;
export const COLUMN_NAME = { type: "string", minLength: 1, maxLength: LIMITS.column } as const;
/** Who a card is for: a person (`person:<id>`) or an agent (`agent:<name>`). */
export const ASSIGNEE = { type: "string", pattern: "^(person|agent):.+$", maxLength: 200 } as const;
export const LABELS = {
  type: "array",
  maxItems: LIMITS.labels,
  items: { type: "string", minLength: 1, maxLength: LIMITS.label },
} as const;
export const DUE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
export const POSITION = { enum: ["top", "bottom"] } as const;

/** Labels as kept: trimmed, without empty ones, once each (in any case), in the order given. */
export function labelsOf(given: string[]): string[] {
  const kept: string[] = [];
  for (const raw of given) {
    const label = raw.trim().replace(/\s+/g, " ");
    if (label && !kept.some((k) => k.toLowerCase() === label.toLowerCase())) kept.push(label);
  }
  return kept;
}

/** A due date, checked to be a real day (`2026-02-30` isn't). */
export function dueOf(given: string): string {
  const day = new Date(`${given}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== given) {
    throw invalid(`“${given}” isn't a day: give it as YYYY-MM-DD.`);
  }
  return given;
}

/** Who an actor is, as a document records it: `person:ana`, `agent:north`. */
export const keyOf = (actor?: Actor) => actor ? `${actor.kind}:${actor.id}` : "system";

/** A new board's or card's id: twelve hex digits. */
export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
