/**
 * Deleting a routine, once it's been said what that means: it stops
 * running, its runs go, and the chats it posted in stay.
 */
import { type ReactNode, useState } from "react";
import { Button, Dialog, message, Notice } from "../../../../../hosts/web/mod.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function DeleteRoutine(
  { open, onClose, routine, name, call, deleted }: {
    open: boolean;
    onClose(): void;
    routine: string;
    name: string;
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
      title={`Delete “${name}”?`}
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
                await call("routine.delete", { routine });
                onClose();
                deleted?.();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete routine
          </Button>
        </>
      }
    >
      <ul className="routine-delete-means">
        <li>
          <b>It stops running</b>, and its record of runs goes with it.
        </li>
        <li>
          <b>The chats it posted in stay,</b>{" "}
          with what the agent answered. To stop it for a while instead, pause it.
        </li>
      </ul>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
