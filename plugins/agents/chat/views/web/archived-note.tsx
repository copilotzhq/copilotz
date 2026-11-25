/**
 * An archived chat, said calmly at the top of its page, or of its staff
 * notes' (archived with it): it's listed apart, and a new message brings it
 * back; Restore is at hand, and a refusal is said in its place.
 */
import { type ReactNode, useState } from "react";
import { Button, message, Notice } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function ArchivedNote(
  { thread, notes, call }: {
    /** The chat, or its notes (restoring them restores it). */
    thread: string;
    /** It's the chat's staff notes' page. */
    notes?: boolean;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Notice
      tone="neutral"
      icon="archive"
      className="chat-archived"
      title={say(notes ? "notesArchivedTitle" : "archivedTitle")}
      action={
        <Button
          size="sm"
          icon="restore"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await call("chat.archive", { thread, archived: false });
            } catch (e) {
              setError(message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {say("restore")}
        </Button>
      }
    >
      {error ?? say("archivedNote")}
    </Notice>
  );
}
