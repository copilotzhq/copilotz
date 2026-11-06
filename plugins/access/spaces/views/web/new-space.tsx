/** Making a space, in place: a button that becomes a name field; Enter makes it, Escape doesn't. */
import { type ReactNode, useId, useState } from "react";
import { Icon, IconButton, Input, message, NavItem } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

export function NewSpace({ create }: { create(name: string): Promise<void> }): ReactNode {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const close = () => {
    setOpen(false);
    setName("");
    setError(undefined);
  };
  if (!open) {
    return (
      <NavItem
        quiet
        onClick={() => setOpen(true)}
        leading={
          <span className="spaces-new-icon">
            <Icon name="plus" size={14} />
          </span>
        }
      >
        {say("newSpace")}
      </NavItem>
    );
  }
  return (
    <form
      className="spaces-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        setError(undefined);
        try {
          await create(name.trim());
          close();
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="copilotz-sr" htmlFor={id}>{say("nameNewSpace")}</label>
      <Input
        id={id}
        size="sm"
        value={name}
        maxLength={60}
        placeholder={say("nameSpace")}
        autoComplete="off"
        autoFocus
        invalid={!!error}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          close();
        }}
        end={
          <>
            <IconButton
              type="submit"
              icon="check"
              label={say("makeSpace")}
              size="sm"
              loading={busy}
              disabled={!name.trim()}
            />
            <IconButton icon="close" label={say("cancel")} size="sm" onClick={close} />
          </>
        }
      />
      {error ? <p role="alert" className="spaces-error">{error}</p> : null}
    </form>
  );
}
