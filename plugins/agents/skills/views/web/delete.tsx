/**
 * Deleting a space's skill, once it's been said what that means: agents
 * there no longer see it, the conversations that read it keep what they
 * read, and it can't be brought back.
 */
import { type ReactNode, useState } from "react";
import { Button, Dialog, message, Notice } from "../../../../../hosts/web/mod.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function DeleteSkill(
  { open, onClose, skill, name, space, call, deleted }: {
    open: boolean;
    onClose(): void;
    skill: string;
    name: string;
    /** Its space's name, as it's shown. */
    space: string;
    call: Call;
    /** Gone: where to go. */
    deleted?(): void;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={`Delete ${name}?`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await call("skill.delete", { skill });
                onClose();
                deleted?.();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete skill
          </Button>
        </>
      }
    >
      <ul className="skill-delete-means">
        <li>
          <b>Agents in {space} no longer see it</b>, nor its files.
        </li>
        <li>
          <b>Chats that used it stay as they are,</b> with what agents read then.
        </li>
        <li>
          <b>It can't be brought back.</b> Download its SKILL.md first to keep a copy.
        </li>
      </ul>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
