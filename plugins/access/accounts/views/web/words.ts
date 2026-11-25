/**
 * What the accounts page says, as plain functions: how an account stands,
 * who it is, how a connection that came back went, whether what was pasted
 * is the address a sign-in lands on, and the line a chat shows when its
 * agents run on the person's plan.
 */
import type { Tone } from "../../../../../hosts/web/mod.ts";
import { defineWords } from "../../../../../hosts/web/words.ts";
import type { Account, Use, Uses } from "../../contract.ts";

/** How an account stands, as its badge says it. */
export function standing(account?: Pick<Account, "status">): { label: string; tone: Tone } {
  switch (account?.status) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "needs_reconnect":
      return { label: "Needs signing in", tone: "warning" };
    case "revoked":
      return { label: "Access ended", tone: "warning" };
    default:
      return { label: "Not connected", tone: "neutral" };
  }
}

/** Who it is there, with its plan: "ana@example.com · Plus plan". */
export const whoOf = (account: Pick<Account, "label" | "plan">) =>
  account.plan ? `${account.label} · ${account.plan} plan` : account.label;

/** Why a connection that came back to the page didn't work, by the code it came with. */
export function failedWhy(code: string | undefined, title: string): string {
  switch (code) {
    case "signed_out":
      return `You were signed out when ${title} sent you back. Sign in, then connect it again.`;
    case "invalid":
      return `That ${title} sign-in had run out, or was started somewhere else. Connect it again.`;
    case "account_refused":
      return `${title} didn't connect it: it wasn't allowed, or it wouldn't take the sign-in.`;
    case "account_unavailable":
      return `${title} couldn't be reached. Nothing changed: try again in a moment.`;
    default:
      return `${title} couldn't be connected. Try again.`;
  }
}

/**
 * Whether pasted text is the address a sign-in lands on: one that starts
 * where it does (`landing`) and carries a code, or an error, and a state.
 */
export function landed(text: string, landing: string): "yes" | "elsewhere" | "no" {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return "no";
  }
  const q = url.searchParams;
  if (!(q.get("code") || q.get("error")) || !q.get("state")) return "no";
  const at = new URL(landing);
  return url.origin === at.origin && url.pathname === at.pathname ? "yes" : "elsewhere";
}

/** An address as people read it: its host and path, without the scheme. */
export const shortAddress = (address: string) => {
  try {
    const url = new URL(address);
    return `${url.host}${url.pathname}`;
  } catch {
    return address;
  }
};

/**
 * The line over a chat's composer: which of its agents run on the person's
 * plan, or whose account needs them; nothing when none do. `named` are the
 * agents' names as the chat shows them.
 */
export function usesLine(
  uses: Uses,
  agents: string[],
  named: (agent: string) => string = (a) => a,
): { tone: "plan" | "reconnect"; text: string; provider: string } | undefined {
  const on = agents.filter((a) => uses[a] && !uses[a].reconnect);
  const lapsed = agents.filter((a) => uses[a]?.reconnect);
  if (on.length) {
    const use = uses[on[0]] as Use;
    const plan = use.plan ? `${use.title} ${use.plan} plan` : `${use.title} plan`;
    const who = on.length === agents.length
      ? "Runs"
      : `${list(on.map(named))} ${on.length > 1 ? "run" : "runs"}`;
    return { tone: "plan", text: `${who} on your ${plan}`, provider: use.provider };
  }
  if (lapsed.length) {
    const use = uses[lapsed[0]];
    return {
      tone: "reconnect",
      text: `Reconnect ${use.title} to run on your plan: for now, the app's models answer`,
      provider: use.provider,
    };
  }
  return undefined;
}

const list = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The words of the accounts page's frame and of connecting an account, in
 * English: an app gives its own under `accounts.<key>`. What a provider
 * says of itself (`allows`, `note`, its title) is the server's: an app
 * gives it under `text.<English>`.
 */
export const say = defineWords("accounts", {
  title: "Your AI",
  about: "The AI plans you pay for, where they run, and your own API keys. Agents working for " +
    "you use them; nobody else can: not the people you share spaces with, nor their agents.",
  otherAccounts: "Other accounts",
  nothing: "Nothing to connect yet",
  nothingText: "This app doesn't offer accounts to connect.",
  connectedNotice: "{provider} is connected: agents working for you use it from now on.",
  dismiss: "Dismiss",
  tryAgain: "Try again",
  foot: "Sign-ins stay on the server, never shown in the app or to agents' models. " +
    "Disconnecting ends them at the provider too.",
  // Connecting one
  connectTitle: "Connect {provider}",
  reconnectTitle: "Reconnect {provider}",
  connectedTitle: "{provider} is connected",
  connect: "Connect",
  reconnect: "Reconnect",
  continueTo: "Continue to {provider}",
  cancel: "Cancel",
  done: "Done",
  planOf: "{provider} {plan} plan",
  nowRuns: "Agents working for you now run on your {provider} plan.",
  nowUses: "Agents working for you can now use your {provider} account.",
  closeTab: "You can close the sign-in tab.",
  startFailed: "Couldn't start connecting: {why}",
  stepSignIn: "Sign in to {provider} and allow access. It opens in a new tab.",
  signInTo: "Sign in to {provider}",
  signInAgain: "Open the sign-in again",
  stepLand:
    "You'll land on a page that doesn't load, at {address}. That's expected. Copy that page's whole address from the address bar.",
  pasteHere: "Paste it here",
  elsewhere: "That's another page's address: it should start with {address}",
  notYet: "That doesn't look like it yet: copy the whole address, from the address bar",
  connectsOnPaste: "It connects as soon as you paste it.",
  paste: "Paste",
  noClipboard: "This browser didn't let the page read what you copied: paste it here.",
  startAgain: "Start again",
  sentBack: "{provider} asks you to sign in and allow it, then sends you back here.",
});
