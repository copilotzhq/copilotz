/**
 * Who's signed in, at the foot of the sidebar, and their menu. They show by
 * their name; with none, by their email; never by their id. The menu opens
 * with their name, which they change or clear there (`person.rename`, in a
 * dialog), then what front ends put there (the `userMenu` resource:
 * `{ label, icon?, href, order? }`, Connected accounts, say), then what the
 * `orgs` slot lists where the app serves many orgs (the org's settings;
 * every org, for staff), then signing out (of every org). The name they give
 * shows at once, wherever they're shown: the host follows their record.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  Avatar,
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  Menu,
  type MenuItem,
  message,
  signOut,
} from "../../../../hosts/web/mod.ts";
import { isPublic } from "../../../../runtime/mod.ts";
import type { UserMenuEntry } from "../shared/menu.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** The longest name someone gives themselves, as `person.rename` takes it. */
const LONGEST = 80;

/** A name as it's kept: one line, trimmed. */
const tidy = (name: string) => name.replace(/[\s\p{Cc}]+/gu, " ").trim();

export function Me(
  { name, email, menu = [], call }: {
    /** Their name, when they have one. */
    name?: string;
    email?: string | null;
    /** What front ends put in the menu, in their order (and the `orgs` slot's, after). */
    menu?: UserMenuEntry[];
    /** How the shell calls Actions: their name is changed with it. */
    call: Call;
  },
): ReactNode {
  const [naming, setNaming] = useState(false);
  // Each opening starts again from their name as it is.
  const [opened, setOpened] = useState(0);
  const items: (MenuItem | "separator")[] = [
    {
      label: name ? say("yourName") : say("addYourName"),
      icon: "pencil",
      onSelect: () => {
        setOpened((n) => n + 1);
        setNaming(true);
      },
    },
    ...menu.map(({ label, icon, href }): MenuItem => ({ label, href, ...(icon ? { icon } : {}) })),
    "separator",
    { label: say("signOut"), icon: "signout", onSelect: () => void signOut() },
  ];
  return (
    <div className="copilotz-me copilotz-me-menu">
      <Menu
        label={say("yourAccount")}
        side="top"
        items={items}
        trigger={(props) => (
          <button type="button" {...props} className="copilotz-me-button">
            <Who name={name} email={email} />
            <Icon name="selector" size={15} className="copilotz-me-chevron" />
          </button>
        )}
      />
      <NameDialog
        key={opened}
        open={naming}
        name={name}
        email={email}
        call={call}
        onClose={() => setNaming(false)}
      />
    </div>
  );
}

/** Them as the menu shows them: a face, their name (else their email), and a note under it. */
function Who({ name, email }: { name?: string; email?: string | null }): ReactNode {
  const shown = name || email || "";
  return (
    <>
      <Avatar name={shown} size={32} />
      <span className="copilotz-me-who">
        <span className="copilotz-me-name">{shown || say("yourAccount")}</span>
        <span className="copilotz-me-note">
          {name && email && email !== name ? email : say("signedIn")}
        </span>
      </span>
    </>
  );
}

/**
 * Their name, to change: the field starts with it, selected, so typing
 * replaces it; Enter saves. Empty, it's cleared, and they go by their email.
 * What they'll look like shows above as they type. While it saves the field
 * waits; what went wrong is said under it, and it stays open to try again.
 */
function NameDialog(
  { open, name, email, call, onClose }: {
    open: boolean;
    name?: string;
    email?: string | null;
    call: Call;
    onClose(): void;
  },
): ReactNode {
  const [draft, setDraft] = useState(name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const field = useRef<HTMLInputElement>(null);
  const form = useId();
  // Opened, the dialog has put focus in the field: what's there is selected.
  useEffect(() => {
    if (open) field.current?.select();
  }, [open]);
  const next = tidy(draft);
  const save = async () => {
    if (busy) return;
    if (next === (name ?? "")) return onClose();
    setBusy(true);
    setError(undefined);
    try {
      await call("person.rename", { name: next });
      onClose();
    } catch (e) {
      // A refusal meant to be read says why; anything else (the connection), to try again.
      setError(isPublic(e) ? say("nameNotSaved", { reason: message(e) }) : say("nameTryAgain"));
      field.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={name ? say("yourName") : say("addYourName")}
      description={say("nameAbout")}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{say("cancel")}</Button>
          <Button type="submit" form={form} variant="primary" loading={busy}>
            {say("save")}
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="copilotz-me-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="copilotz-me-preview" aria-hidden="true">
          <Who name={next} email={email} />
        </div>
        <Field
          label={say("nameLabel")}
          error={error}
          {...(email ? { hint: say("nameEmpty") } : {})}
        >
          {(control) => (
            <Input
              {...control}
              ref={field}
              value={draft}
              maxLength={LONGEST}
              autoComplete="name"
              autoCapitalize="words"
              spellCheck={false}
              readOnly={busy}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(undefined);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
