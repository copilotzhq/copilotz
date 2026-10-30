/**
 * A computer's page: its header (the name, renamed in place; online, or
 * when it was last seen; what it is; a menu to rename or forget it, which
 * asks first), then its workspace in a space's folder.
 */
import { type ReactNode, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  go,
  Icon,
  InlineEdit,
  Menu,
  message,
  Notice,
  Page,
  Time,
  Title,
} from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import type { Info } from "../../shared/workloads.ts";
import { ComputerMark } from "./mark.tsx";
import { type Named, nameOf, systemOf, tilde } from "./names.ts";
import { Workspace } from "./workspace.tsx";

export type Space = { _id: string; name: string; kind: string };
type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function ComputerPage(
  { computer, spaces, desks, here, me, agents, call }: {
    computer: Computer;
    spaces: Space[];
    desks: Desk[];
    here?: string;
    me?: string;
    /** Agents as they're named, for whose each job is. */
    agents?: Record<string, Named>;
    call: Call;
  },
): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const name = nameOf(computer);
  const info = (computer.info ?? {}) as Partial<Info>;
  return (
    <Page
      className="computer-page"
      width="lg"
      leading={<ComputerMark online={computer.online} size="lg" />}
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
      badges={renaming ? null : (
        computer.online
          ? (
            <Badge tone="success" className="computer-presence">
              <span className="computer-presence-dot" aria-hidden="true" />Online
            </Badge>
          )
          : <Badge className="computer-presence">Offline</Badge>
      )}
      actions={
        <Menu
          label={`${name}: more`}
          items={[
            { label: "Rename", icon: "pencil", onSelect: () => setRenaming(true) },
            "separator",
            {
              label: "Forget this computer",
              icon: "trash",
              tone: "destructive",
              onSelect: () => setForgetting(true),
            },
          ]}
        />
      }
      description={<Facts computer={computer} info={info} />}
    >
      <Title text={name} />
      <Workspace
        computer={computer}
        spaces={spaces}
        desks={desks}
        here={here}
        me={me}
        agents={agents}
        call={call}
      />
      <Forget
        open={forgetting}
        onClose={() => setForgetting(false)}
        name={name}
        root={info.root}
        forget={async () => {
          await call("computer.forget", { computer: computer._id });
          go(here ? `/?in=${encodeURIComponent(here)}` : "/");
        }}
      />
    </Page>
  );
}

/** What the computer is, in a line: when it was seen, its system, host, folder and browser. */
function Facts({ computer, info }: { computer: Computer; info: Partial<Info> }): ReactNode {
  const browser = info.browser
    ? info.browser.split(/[\\/]/).pop()?.replace(/\.(app|exe)$/i, "")
    : undefined;
  return (
    <span className="computer-facts">
      {computer.online ? null : (
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
      {info.hostname ? <span>{info.hostname}</span> : null}
      {info.root
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

/** Forgetting, once they've said so: what it means, and that the files stay. */
function Forget(
  { open, onClose, name, root, forget }: {
    open: boolean;
    onClose(): void;
    name: string;
    root?: string;
    forget(): Promise<void>;
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
      title={`Forget ${name}?`}
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
                await forget();
              } catch (e) {
                setError(message(e));
                setBusy(false);
              }
            }}
          >
            Forget it
          </Button>
        </>
      }
    >
      <p className="computer-forget-text">
        Your agents stop using it, and it can't connect again: to use it again, connect it with a
        new code. Its files stay where they are{root
          ? (
            <>
              , in <code>{tilde(root)}</code>
            </>
          )
          : null}. On it, <code>computer uninstall</code> removes the program from its login items.
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
