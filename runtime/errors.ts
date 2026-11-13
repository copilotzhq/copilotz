/**
 * Refusals, as everything throws and answers them: a message people read, and
 * a code callers act on. `people` and `inPerson` are what most Actions `allow`
 * (`people` lets an agent working for a person in, `inPerson` never does); the
 * few that contacts may call too say `peopleOrContacts`. The runtime asks an
 * agent's `allow` for whom it works for too (see `allows`).
 *
 * A failure made `public` says its message to whoever called, wherever they
 * are: also to a model outside the app (over MCP), which no other error's
 * words reach (a driver's, a stack's, the runtime's about its insides, a
 * store's about a document). A tool's refusal meant for the model that
 * called it is public: "Search trips first."
 */
import type { Actor } from "./store.ts";
import { onBehalf } from "./actor.ts";

/** What a failure says about itself beyond its code: whether its message is for any caller. */
export type FailureOptions = { public?: boolean };

export const failure = (
  code: string,
  message: string,
  options: FailureOptions = {},
): Error & { code: string; public?: true } =>
  Object.assign(new Error(message), { code }, options.public ? { public: true as const } : {});

/** Whether an error's message is for any caller (`failure(code, message, { public: true })`). */
export const isPublic = (error: unknown): boolean =>
  (error as { public?: unknown } | null)?.public === true;
export const forbidden = (message: string): Error & { code: string } =>
  failure("forbidden", message);
export const invalid = (message: string): Error & { code: string } => failure("invalid", message);

/** Whom an agent works for (`for`), if it works for anyone. */
const behalf = (actor: Actor): Actor | undefined =>
  actor.kind === "agent" && actor.for && typeof actor.for === "object"
    ? actor.for as Actor
    : undefined;

/** People, keys acting for them, and an agent working for one of them. */
export const people = (actor: Actor): boolean =>
  actor.kind === "person" || (!!behalf(actor) && people(behalf(actor)!));
/**
 * A person themselves, for what only they decide (consent, keys, who's in a
 * space, their sessions and accounts): never a key, never an agent, whomever
 * it works for, and never work done for them (`onBehalf`: a routine set
 * going, code acting as them for an agent).
 */
export const inPerson = (actor: Actor): boolean => actor.kind === "person" && !onBehalf(actor);
/**
 * A contact: someone outside the org talking to an app's agents (a WhatsApp
 * customer), or an agent working for one.
 */
export const contacts = (actor: Actor): boolean =>
  actor.kind === "contact" || (!!behalf(actor) && contacts(behalf(actor)!));
/**
 * Whoever calls a public, stateless interface (a public MCP server's tools)
 * without being anyone: `{ kind: "public" }`. They read only what's let to
 * the public, and write nothing. An outside call with no actor at all is
 * still no one, never this.
 */
export const publicCallers = (actor: Actor): boolean => actor.kind === "public";
/** People, and contacts: what an Action opened to contacts allows (and their agents). */
export const peopleOrContacts = (actor: Actor): boolean => people(actor) || contacts(actor);
