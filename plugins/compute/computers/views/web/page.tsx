/**
 * A computer's page: its header (the name, renamed in place; online, or
 * when it was last seen; what it is; a menu to rename or forget it, which
 * asks first), then its workspace in a space's folder. A computer of a kind
 * (a cloud computer) says its state and what it is through its kind's View,
 * wakes as its page opens, and is removed as its kind says (deleting its
 * disk), asked first.
 */
import { type ReactNode, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  go,
  Icon,
  InlineEdit,
  LazyView,
  Menu,
  message,
  Notice,
  Page,
  Time,
  Title,
} from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import type { Preview } from "../../collections/preview.ts";
import type { Info } from "../../shared/workloads.ts";
import { type JobAction, type Kind, titled } from "./kinds.ts";
import { ComputerMark } from "./mark.tsx";
import { type Named, nameOf, systemOf, tilde } from "./names.ts";
import { Workspace } from "./workspace.tsx";

export type Space = { _id: string; name: string; kind: string };
type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function ComputerPage(
  { computer, spaces, desks, here, me, agents, names, call, kind, previews, jobActions }: {
    computer: Computer;
    spaces: Space[];
    desks: Desk[];
    here?: string;
    me?: string;
    /** Agents as they're named, for whose each job is. */
    agents?: Record<string, Named>;
    /** People by name (`namesIn`): whose each is, who started each job. */
    names?: Record<string, string>;
    call: Call;
    /** Its kind, a cloud computer's. */
    kind?: Kind;
    /** The previews of what it serves, in the spaces it's in. */
    previews?: Preview[];
    jobActions?: JobAction[];
  },
): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const name = nameOf(computer);
  const info = (computer.info ?? {}) as Partial<Info>;
  const remove = kind?.remove;
  const leave = () => go(here ? `/?in=${encodeURIComponent(here)}` : "/");
  return (
    <Page
      className="computer-page"
      width="lg"
      leading={<ComputerMark online={computer.online} size="lg" icon={kind?.icon} />}
      title={renaming
        ? (
          <InlineEdit
            label="The computer's name"
            value={name}
            done={() => setRenaming(false)}
            save={(next) => call("computer.rename", { computer: computer._id, name: next })}
          />
        )
        : name}
      badges={renaming ? null : kind
        ? (
          <LazyView
            kind={kind.view}
            item={{ _id: computer._id }}
            hints={{ mode: "badge" }}
            fallback={null}
          />
        )
        : computer.online
        ? (
          <Badge tone="success" className="computer-presence">
            <span className="computer-presence-dot" aria-hidden="true" />Online
          </Badge>
        )
        : <Badge className="computer-presence">Offline</Badge>}
      actions={
        <Menu
          label={`${name}: more`}
          items={[
            { label: "Rename", icon: "pencil", onSelect: () => setRenaming(true) },
            "separator",
            {
              label: remove?.label ?? "Forget this computer",
              icon: "trash",
              tone: "destructive",
              onSelect: () => setForgetting(true),
            },
          ]}
        />
      }
      description={<Facts computer={computer} info={info} kind={kind} />}
    >
      <Title text={name} />
      <Workspace
        computer={computer}
        spaces={spaces}
        desks={desks}
        here={here}
        me={me}
        agents={agents}
        names={names}
        call={call}
        {...(kind ? { kind, wake: true } : {})}
        {...(previews ? { previews } : {})}
        {...(jobActions ? { jobActions } : {})}
      />
      {remove
        ? (
          <Confirm
            open={forgetting}
            onClose={() => setForgetting(false)}
            title={titled(remove.title, name)}
            button={remove.button}
            act={async () => {
              await call(remove.action, { computer: computer._id });
              leave();
            }}
          >
            <p className="computer-forget-text">{titled(remove.text, name)}</p>
          </Confirm>
        )
        : (
          <Confirm
            open={forgetting}
            onClose={() => setForgetting(false)}
            title={`Forget ${name}?`}
            button="Forget it"
            act={async () => {
              await call("computer.forget", { computer: computer._id });
              leave();
            }}
          >
            <p className="computer-forget-text">
              Your agents stop using it, and it can't connect again: to use it again, connect it
              with a new code. Its files stay where they are{info.root
                ? (
                  <>
                    , in <code>{tilde(info.root)}</code>
                  </>
                )
                : null}. On it, <code>computer uninstall</code>{" "}
              removes the program from its login items.
            </p>
          </Confirm>
        )}
    </Page>
  );
}

/**
 * What the computer is, in a line: when it was seen, its system, host,
 * folder and browser; a cloud computer's kind says what it is (its size,
 * how long it's been awake) in place of when it was seen, its host and its
 * folder (the VM's, which mean nothing to its person).
 */
function Facts(
  { computer, info, kind }: { computer: Computer; info: Partial<Info>; kind?: Kind },
): ReactNode {
  const browser = info.browser
    ? info.browser.split(/[\\/]/).pop()?.replace(/\.(app|exe)$/i, "")
    : undefined;
  return (
    <span className="computer-facts">
      {kind
        ? (
          <LazyView
            kind={kind.view}
            item={{ _id: computer._id }}
            hints={{ mode: "facts" }}
            fallback={null}
          />
        )
        : computer.online
        ? null
        : (
          <span>
            {computer.seen
              ? (
                <>
                  Last seen <Time at={computer.seen} long />
                </>
              )
              : "Not connected yet"}
          </span>
        )}
      {info.os
        ? (
          <span title={info.version ? `Computer program ${info.version}` : undefined}>
            <Icon name="computer" size={14} />
            {[systemOf(info.os), info.arch].filter(Boolean).join(" · ")}
          </span>
        )
        : null}
      {info.hostname && !kind ? <span>{info.hostname}</span> : null}
      {info.root && !kind
        ? (
          <span title={info.root}>
            <Icon name="folder" size={14} />
            <code>{tilde(info.root)}</code>
          </span>
        )
        : null}
      {info.os
        ? (
          <span title={info.browser ?? undefined}>
            <Icon name="globe" size={14} />
            {browser ? `Browser: ${browser}` : "No browser found"}
          </span>
        )
        : null}
    </span>
  );
}

/** Forgetting it (or deleting it, a cloud computer), once they've said so: what it means first. */
function Confirm(
  { open, onClose, title, button, act, children }: {
    open: boolean;
    onClose(): void;
    title: string;
    button: string;
    act(): Promise<void>;
    children: ReactNode;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog
      open={open}
      onClose={() => {
        setError(undefined);
        onClose();
      }}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await act();
              } catch (e) {
                setError(message(e));
                setBusy(false);
              }
            }}
          >
            {button}
          </Button>
        </>
      }
    >
      {children}
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
