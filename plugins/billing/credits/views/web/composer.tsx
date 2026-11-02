/**
 * The note above where you type (kind `billing.composer`, chat's
 * `composerNotes`): so people know before they send. Nothing at all while it
 * asks, when there's nothing to say, or if it can't ask. Stopped, it says the
 * org is out of credits or at its budget: with a way to Billing for those who
 * run it, and who can help for everyone else; that one can't be put away. Low,
 * for those who run it, what's left and a way to add more, which they can put
 * away for this visit. It asks when it appears, when the page comes back, and
 * when agents finish working (`hints.working`), which is when it changes.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Button, IconButton, Notice, useOrgs } from "../../../../../hosts/web/mod.ts";
import { type Notice as Said, noticeKey, noticeSaid } from "./numbers.ts";
import { STYLE } from "./style.ts";

const BILLING = "/org?tab=billing";

/** Where dismissing is kept: for this visit, this org. */
const keyOf = (org: string, said: Said) => `billing-note-away:${org}:${noticeKey(said)}`;

const away = (key: string) => {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

export const composerNoteView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => (
  <>
    <style href="billing-web" precedence="copilotz">{STYLE}</style>
    <Note call={ctx.call} working={ctx.hints.working === true} />
  </>
);

function Note(
  { call, working }: {
    call: <R = unknown>(action: string, input?: unknown) => Promise<R>;
    working: boolean;
  },
): ReactNode {
  const orgs = useOrgs();
  const here = orgs.status === "ready" ? orgs.here : undefined;
  const [said, setSaid] = useState<Said | null>(null);
  const [gone, setGone] = useState<string>();

  useEffect(() => {
    if (working) return;
    let current = true;
    const ask = () =>
      call<Said | null>("billing.notice", {}).then(
        (answer) => current && setSaid(answer),
        // A failure to ask says nothing: the real thing decides when someone sends.
        () => {},
      );
    const again = () => document.visibilityState === "visible" && void ask();
    void ask();
    document.addEventListener("visibilitychange", again);
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", again);
    };
  }, [working]);

  if (!said) return null;
  const key = keyOf(here?.id ?? "", said);
  if (said.tone === "low" && (gone === key || away(key))) return null;
  const words = noticeSaid(said, here?.kind === "personal");
  const stop = said.tone === "stop";
  return (
    <Notice
      tone={stop ? "warning" : "neutral"}
      role="status"
      className="billing-note"
      action={
        <>
          {said.runs
            ? (
              <Button size="sm" variant={stop ? "primary" : "outline"} href={BILLING}>
                {stop ? "Go to Billing" : said.why === "budget" ? "Change budget" : "Add credits"}
              </Button>
            )
            : null}
          {stop ? null : (
            <IconButton
              icon="close"
              size="sm"
              label="Not now"
              onClick={() => {
                try {
                  sessionStorage.setItem(key, "1");
                } catch { /* It stays away for this page only. */ }
                setGone(key);
              }}
            />
          )}
        </>
      }
    >
      <b>{words.title}{words.more ? "." : ""}</b>
      {words.more ? ` ${words.more}` : ""}
    </Notice>
  );
}
