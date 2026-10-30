/**
 * A space's computers (its desks), as its Computer tab lists them: each with
 * whether it's online (a cloud computer: its state, from its kind's View),
 * whose it is, and whether it's the one agents use (when there are
 * several), picked to work on below; its menu (make it the default, ask its
 * owner first, open its page, move it to another space, through the command
 * palette's space picker; take it out of the space, which asks first). Then
 * adding one: where the app has kinds of computer that make one (a cloud
 * computer), the ways to add one as a choice, in a dialog (and as cards
 * while there's none yet); else connecting a computer to this space; or
 * putting one of yours here. Sharing one into a shared space says plainly
 * what it means first: members' agents run commands as you, on your
 * machine; and lets you keep the yes to yourself.
 */
import { type ReactNode, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Icon,
  LazyView,
  Menu,
  type MenuItem,
  message,
  Notice,
  openPalette,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../../../access/spaces/contract.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import { AddChoices, AddDialog, type AddStep } from "./add.tsx";
import type { Kind } from "./kinds.ts";
import { ComputerMark } from "./mark.tsx";
import { moveStep } from "./move.ts";
import { folderPath, nameOf } from "./names.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A space as people say it: yours is Personal. */
const called = (space: Reached) => space.kind === "personal" ? "Personal" : space.name;

/** What it means to share a computer into a shared space, said before it's done. */
export function ShareWarning(
  { space, name, kept }: { space: Reached; name: string; kept?: boolean },
): ReactNode {
  return (
    <Notice tone="warning" icon="alert" title={`${called(space)}'s members will work on ${name}`}>
      They, and the agents working for them, run commands, start jobs and change files there, in a
      folder of its own. It all runs as you{kept ? "" : ", on your machine"}: share it with people
      you trust.
    </Notice>
  );
}

export function Desks(
  { space, desks, mine, chosen, choose, me, call, compact, kinds = [], kindOf = {} }: {
    space: Reached;
    desks: Desk[];
    /** The person's computers. */
    mine: Computer[];
    /** The desk worked on below. */
    chosen?: string;
    choose(desk: string): void;
    me?: string;
    call: Call;
    compact?: boolean;
    /** Kinds of computer beyond people's own machines, and the person's computers of one. */
    kinds?: Kind[];
    kindOf?: Record<string, Kind>;
  },
): ReactNode {
  const [adding, setAdding] = useState<AddStep>();
  const [sharing, setSharing] = useState<Computer>();
  const [removing, setRemoving] = useState<Desk>();
  const [error, setError] = useState<string>();
  const shared = space.kind !== "personal";
  const manage = space.can.includes("manage");
  const others = mine.filter((c) => !desks.some((d) => d.computer === c._id));
  const makers = kinds.filter((k) => k.add);
  const act = async (action: string, input: unknown) => {
    setError(undefined);
    try {
      await call(action, input);
    } catch (e) {
      setError(message(e));
    }
  };
  const share = (computer: Computer) =>
    shared
      ? setSharing(computer)
      : void act("computer.share", { computer: computer._id, in: space._id });
  /** One of yours, as a menu says it: a kind's, or offline. */
  const yours = (c: Computer) =>
    `${nameOf(c)}${
      kindOf[c._id] ? ` (${kindOf[c._id].title.toLowerCase()})` : c.online ? "" : " (offline)"
    }`;
  const menu: (MenuItem | "separator")[] = [
    ...makers.map((k): MenuItem => ({
      label: `${k.add!.heading ?? k.add!.title}…`,
      icon: k.icon ?? "server",
      onSelect: () => setAdding(`kind:${k.key}`),
    })),
    {
      label: makers.length ? "Connect your own machine…" : "Connect a computer",
      icon: makers.length ? "computer" : "plus",
      onSelect: () => setAdding("connect"),
    },
    ...(others.length ? ["separator" as const] : []),
    ...others.map((c): MenuItem => ({
      label: `Add ${yours(c)}`,
      icon: kindOf[c._id]?.icon ?? "computer",
      onSelect: () => share(c),
    })),
  ];
  return (
    <div className={`desks${compact ? " desks-compact" : ""}`}>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {desks.length
        ? (
          <ul className="desks-list" aria-label={`${called(space)}'s computers`}>
            {desks.map((d) => (
              <DeskCard
                key={d._id}
                desk={d}
                space={space}
                several={desks.length > 1}
                chosen={d._id === chosen}
                choose={() => choose(d._id)}
                mine={d.owner === me}
                manage={manage}
                act={act}
                remove={() => setRemoving(d)}
                move={() =>
                  openPalette(moveStep({ desk: d._id, name: nameOf(d), from: space._id, call }))}
                kind={kindOf[d.computer] ?? kinds.find((k) => k.key === d.status?.kind)}
              />
            ))}
            <li className="desks-add">
              <Menu
                label="Add a computer to this space"
                text="Add a computer"
                variant={compact ? "ghost" : "outline"}
                size="sm"
                items={menu}
              />
            </li>
          </ul>
        )
        : (
          <div className={`desks-none${makers.length ? " desks-none-choices" : ""}`}>
            <span className="desks-none-icon">
              <Icon name="computer" size={26} />
            </span>
            <h3>{shared ? `No computer in ${space.name} yet` : "No computer here yet"}</h3>
            <p>
              {makers.length ? "Add one" : "Connect one"}, and agents in{" "}
              {shared ? "this space's" : "your"}{" "}
              chats run commands and jobs, read and write files, browse and search on it, in a
              folder of its own. They ask before they change anything.
            </p>
            {makers.length
              ? <AddChoices kinds={makers} pick={setAdding} compact={compact} />
              : null}
            <div className="desks-none-actions">
              {makers.length
                ? null
                : (
                  <Button variant="primary" icon="plus" onClick={() => setAdding("connect")}>
                    Connect a computer
                  </Button>
                )}
              {others.length
                ? (
                  <Menu
                    label="Add one of your computers"
                    text="Add one of yours"
                    icon="computer"
                    variant={makers.length ? "ghost" : "outline"}
                    items={others.map((c) => ({
                      label: yours(c),
                      icon: kindOf[c._id]?.icon ?? "computer",
                      onSelect: () => share(c),
                    }))}
                  />
                )
                : null}
            </div>
          </div>
        )}
      {shared && !compact && desks.length ? <Whose desks={desks} space={space} me={me} /> : null}
      <AddDialog
        {...(adding ? { step: adding } : {})}
        go={setAdding}
        onClose={() => setAdding(undefined)}
        call={call}
        computers={mine}
        space={space._id}
        where={called(space)}
        {...(shared ? { notice: <ShareWarning space={space} name="it" /> } : {})}
        kinds={kinds}
        kindOf={kindOf}
        others={others}
        share={share}
      />
      <ShareDialog
        computer={sharing}
        space={space}
        onClose={() => setSharing(undefined)}
        call={call}
        kept={!!sharing && !!kindOf[sharing._id]}
      />
      <RemoveDialog
        desk={removing}
        space={space}
        onClose={() => setRemoving(undefined)}
        call={call}
      />
    </div>
  );
}

/** Whose machines these are, and what that means: yours run what others do here as you. */
function Whose({ desks, space, me }: { desks: Desk[]; space: Reached; me?: string }): ReactNode {
  const yours = desks.filter((d) => d.owner === me);
  const theirs = desks.filter((d) => d.owner !== me);
  return (
    <div className="desks-notes">
      {yours.length
        ? (
          <p className="desks-note">
            <Icon name="lock" size={13} />
            <span>
              {yours.length === 1 ? `${nameOf(yours[0])} is yours` : "These are yours"}: what{" "}
              {space.name}'s members and their agents do on it runs as you.{" "}
              {yours.some((d) => d.answers === "owner")
                ? "Their agents ask you first."
                : "Each person answers what their own agents ask."}
            </span>
          </p>
        )
        : null}
      {[...new Set(theirs.map((d) => d.owner))].map((owner) => {
        const shown = theirs.filter((d) => d.owner === owner);
        const asks = shown.some((d) => d.answers === "owner");
        return (
          <p key={owner} className="desks-note">
            <Icon name="computer" size={13} />
            <span>
              {shown.length === 1 ? `${nameOf(shown[0])} is ${owner}'s` : `These are ${owner}'s`}
              , shared with {space.name}: what you and your agents do there runs on{" "}
              {owner}'s machine, as {owner}. {asks
                ? `${owner} answers what your agents ask there.`
                : "You answer what your agents ask there."}
            </span>
          </p>
        );
      })}
    </div>
  );
}

function DeskCard(
  { desk: d, space, several, chosen, choose, mine, manage, act, remove, move, kind }: {
    desk: Desk;
    space: Reached;
    several: boolean;
    chosen: boolean;
    choose(): void;
    mine: boolean;
    manage: boolean;
    act(action: string, input: unknown): Promise<void>;
    remove(): void;
    /** Moves it to another space (its owner only). */
    move(): void;
    /** Its kind, a cloud computer's: its state shows instead of online or not. */
    kind?: Kind;
  },
): ReactNode {
  const name = nameOf(d);
  const shared = space.kind !== "personal";
  const items: (MenuItem | "separator")[] = [
    ...(several && !d.default && (mine || manage)
      ? [{
        label: "Make it the one agents use",
        icon: "star" as const,
        onSelect: () => void act("computer.default", { desk: d._id }),
      }]
      : []),
    ...(mine && shared
      ? [{
        label: d.answers === "owner"
          ? "Let each asker answer their agents"
          : "Ask me before others' agents act",
        icon: "lock" as const,
        onSelect: () =>
          void act("computer.share", {
            computer: d.computer,
            in: space._id,
            answers: d.answers === "owner" ? "asker" : "owner",
          }),
      }]
      : []),
    ...(mine
      ? [{
        label: kind ? "Open it" : "Open its page",
        icon: "external" as const,
        href: `/computer/${encodeURIComponent(d.computer)}?in=${encodeURIComponent(space._id)}`,
      }, { label: "Move to another space…", icon: "move" as const, onSelect: move }]
      : []),
    ...(mine || manage
      ? [
        "separator" as const,
        {
          label: `Take it out of ${called(space)}`,
          icon: "close" as const,
          tone: "destructive" as const,
          onSelect: remove,
        },
      ]
      : []),
  ];
  const facts = (
    <span className="desk-meta">
      <span>{mine ? "Yours" : `${d.owner}'s`}</span>
      <span aria-hidden="true">·</span>
      {kind
        ? (
          <LazyView
            kind={kind.view}
            item={{ _id: d.computer, ...(d.status ? { status: d.status } : {}) }}
            hints={{ mode: "badge" }}
            fallback={<span>{kind.title}</span>}
          />
        )
        : d.online
        ? <span className="desk-online">Online</span>
        : d.seen
        ? (
          <span>
            Seen <Time at={d.seen} />
          </span>
        )
        : <span>Offline</span>}
      {shared && d.answers === "owner"
        ? (
          <>
            <span aria-hidden="true">·</span>
            <span>Asks {mine ? "you" : d.owner} first</span>
          </>
        )
        : null}
    </span>
  );
  const inside = (
    <>
      <ComputerMark online={d.online} icon={kind?.icon} />
      <span className="desk-text">
        <span className="desk-name">
          <span className="desk-name-text">{name}</span>
          {several && d.default ? <Badge tone="primary">Agents use it</Badge> : null}
        </span>
        {facts}
      </span>
    </>
  );
  return (
    <Card as="li" padding="none" className="desk" data-chosen={(several && chosen) || undefined}>
      {several
        ? (
          <button
            type="button"
            className="desk-pick"
            aria-pressed={chosen}
            title={`Work on ${name}: ${folderPath(d, d.folder) ?? d.folder}`}
            onClick={choose}
          >
            {inside}
          </button>
        )
        : <span className="desk-pick">{inside}</span>}
      {items.length ? <Menu label={`${name}: more`} items={items} align="end" size="sm" /> : null}
    </Card>
  );
}

/** Putting one of yours into a shared space, once you've read what it means. */
function ShareDialog(
  { computer, space, onClose, call, kept }: {
    computer?: Computer;
    space: Reached;
    onClose(): void;
    call: Call;
    /** Whether it's one the app keeps (a cloud computer), not the person's machine. */
    kept?: boolean;
  },
): ReactNode {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = computer ? nameOf(computer) : "";
  const close = () => {
    setAsk(false);
    setError(undefined);
    onClose();
  };
  return (
    <Dialog
      open={!!computer}
      onClose={close}
      title={`Share ${name} with ${space.name}?`}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            icon="share"
            loading={busy}
            onClick={async () => {
              if (!computer) return;
              setBusy(true);
              try {
                await call("computer.share", {
                  computer: computer._id,
                  in: space._id,
                  answers: ask ? "owner" : "asker",
                });
                close();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Share it
          </Button>
        </>
      }
    >
      <div className="desks-dialog">
        <ShareWarning space={space} name={name} kept={kept} />
        <Checkbox
          checked={ask}
          onChange={(event) => setAsk(event.target.checked)}
          label={`Ask me before their agents run commands or change files on ${name}`}
        />
        <p className="desks-dialog-hint">
          Otherwise each person answers what their own agents ask. You can change this later, or
          take {name} out of {space.name}, from its menu here.
        </p>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </div>
    </Dialog>
  );
}

/** Taking a computer out of the space, once they've said so. */
function RemoveDialog(
  { desk, space, onClose, call }: {
    desk?: Desk;
    space: Reached;
    onClose(): void;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = desk ? nameOf(desk) : "";
  const close = () => {
    setError(undefined);
    onClose();
  };
  return (
    <Dialog
      open={!!desk}
      onClose={close}
      size="sm"
      title={`Take ${name} out of ${called(space)}?`}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="destructive"
            loading={busy}
            onClick={async () => {
              if (!desk) return;
              setBusy(true);
              try {
                await call("computer.unshare", { desk: desk._id });
                close();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Take it out
          </Button>
        </>
      }
    >
      <p className="desks-dialog-text">
        Agents here stop using it, and what they waited on or were let do here goes with it. Its
        folder{desk?.folder
          ? (
            <>
              (<code>{desk.folder}</code>)
            </>
          )
          : null} stays on the machine.
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
