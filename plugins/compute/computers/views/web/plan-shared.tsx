/**
 * A computer signed in to a plan isn't shared with others' agents until its
 * person signs out of it, from Your AI: what a space's Computer tab says
 * when they try (desks.tsx).
 */
import type { ReactNode } from "react";
import { Button, Notice } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

/** Why a computer signed in to a plan can't be shared with others' agents, and where to sign out of it. */
export function SignedInNotice({ computer, plan }: { computer: string; plan: string }): ReactNode {
  return (
    <Notice
      tone="warning"
      icon="lock"
      role="alert"
      action={<Button size="sm" href="/accounts">{say("plansTitle")}</Button>}
    >
      {say("shareSignedIn", { computer, plan })}
    </Notice>
  );
}
