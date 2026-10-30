/**
 * Adding a computer to a space, where there's more than one way: a kind of
 * computer another front end adds (a cloud computer: `computerKinds`'
 * `add`, its View drawn in the dialog), connecting your own machine (the
 * connect flow), or one of yours already connected. One dialog whose steps
 * change in place, each with a way back to the choice. `AddChoices` are
 * the same choices as cards, for a space with no computer yet.
 */
import type { ReactNode } from "react";
import { Button, Card, Dialog, Icon, LazyView } from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import { useConnect } from "./connect.tsx";
import type { Kind } from "./kinds.ts";
import { ComputerMark } from "./mark.tsx";
import { nameOf } from "./names.ts";

/** Where the dialog is: choosing, connecting your own machine, or making one of a kind (`kind:<key>`). */
export type AddStep = "choose" | "connect" | `kind:${string}`;

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** The ways to add a computer, as cards: each kind that makes one, then your own machine. */
export function AddChoices(
  { kinds, pick, compact }: { kinds: Kind[]; pick(step: AddStep): void; compact?: boolean },
): ReactNode {
  return (
    <ul className={`add-choices${compact ? " add-choices-compact" : ""}`}>
      {kinds.flatMap((k) =>
        k.add
          ? [
            <li key={k.key}>
              {k.blocked
                ? (
                  // Not now (only admins make them here, a budget spent): what it is, and why not.
                  <Card padding="none" className="add-choice" data-blocked aria-disabled="true">
                    <span className="add-choice-icon" data-kind={k.key}>
                      <Icon name={k.icon ?? "server"} size={20} />
                    </span>
                    <span className="add-choice-text">
                      <span className="add-choice-title">{k.add.title}</span>
                      <span className="add-choice-description add-choice-why">
                        <Icon name="lock" size={13} />
                        {k.blocked}
                      </span>
                    </span>
                  </Card>
                )
                : (
                  <Card
                    as="button"
                    interactive
                    padding="none"
                    className="add-choice"
                    onClick={() => pick(`kind:${k.key}`)}
                  >
                    <span className="add-choice-icon" data-kind={k.key}>
                      <Icon name={k.icon ?? "server"} size={20} />
                    </span>
                    <span className="add-choice-text">
                      <span className="add-choice-title">{k.add.title}</span>
                      <span className="add-choice-description">{k.add.description}</span>
                    </span>
                    <Icon name="chevron" size={16} className="add-choice-go" />
                  </Card>
                )}
            </li>,
          ]
          : []
      )}
      <li>
        <Card
          as="button"
          interactive
          padding="none"
          className="add-choice"
          onClick={() => pick("connect")}
        >
          <span className="add-choice-icon">
            <Icon name="computer" size={20} />
          </span>
          <span className="add-choice-text">
            <span className="add-choice-title">Connect your own machine</span>
            <span className="add-choice-description">
              Your Mac, Linux or Windows computer, with a small program you install. Free; agents
              use it while it's on.
            </span>
          </span>
          <Icon name="chevron" size={16} className="add-choice-go" />
        </Card>
      </li>
    </ul>
  );
}

export function AddDialog(
  { step, go, onClose, call, computers, space, where, notice, kinds, kindOf, others, share }: {
    /** The step shown; none: closed. */
    step?: AddStep;
    go(step: AddStep): void;
    onClose(): void;
    call: Call;
    /** The person's computers, live (connecting one waits for it to come). */
    computers: Computer[];
    space: string;
    /** The space's name, as titles say it. */
    where?: string;
    /** What to know before connecting (sharing your machine with a space). */
    notice?: ReactNode;
    kinds: Kind[];
    /** The kind of each of the person's computers that has one. */
    kindOf: Record<string, Kind>;
    /** The person's computers not here yet, and putting one here. */
    others: Computer[];
    share(computer: Computer): void;
  },
): ReactNode {
  const makers = kinds.filter((k) => k.add);
  const kind = makers.find((k) => step === `kind:${k.key}`);
  const back = () => go("choose");
  const connecting = useConnect({
    open: step === "connect",
    onClose,
    call,
    computers,
    here: space,
    ...(where ? { where } : {}),
    ...(notice ? { notice } : {}),
    back,
  });
  const close = <Button onClick={onClose}>Close</Button>;
  const backButton = (
    <Button variant="ghost" icon="chevron-left" className="add-back" onClick={back}>
      Back
    </Button>
  );
  // One dialog, its steps in place: moving between them doesn't close and open it again.
  const connect = step === "connect";
  return (
    <Dialog
      open={!!step}
      onClose={onClose}
      size={kind || connect ? "lg" : "md"}
      title={connect
        ? connecting.title
        : kind?.add
        ? kind.add.heading ?? kind.add.title
        : where
        ? `Add a computer to ${where}`
        : "Add a computer"}
      description={connect
        ? connecting.description
        : kind
        ? undefined
        : "Agents here run commands and jobs, read and write files, browse and search on it, " +
          "in a folder of its own."}
      footer={connect ? connecting.footer : kind ? <>{backButton}{close}</> : close}
    >
      {connect ? connecting.body : kind?.add
        ? (
          <LazyView
            kind={kind.add.view}
            item={{ _id: space }}
            hints={{ in: space, ...(where ? { where } : {}) }}
          />
        )
        : (
          <div className="add-body">
            <AddChoices kinds={makers} pick={go} />
            {others.length
              ? (
                <section className="add-yours" aria-label="Your computers">
                  <h3>Or add one of yours</h3>
                  <ul>
                    {others.map((c) => {
                      const of = kindOf[c._id];
                      return (
                        <li key={c._id}>
                          <button
                            type="button"
                            className="add-yours-item"
                            onClick={() => {
                              onClose();
                              share(c);
                            }}
                          >
                            <ComputerMark online={c.online} icon={of?.icon} />
                            <span className="add-yours-name">{nameOf(c)}</span>
                            <span className="add-yours-state">
                              {of
                                ? of.title
                                : c.online
                                ? <span className="desk-online">Online</span>
                                : "Offline"}
                            </span>
                            <Icon name="plus" size={15} className="add-yours-plus" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )
              : null}
          </div>
        )}
    </Dialog>
  );
}
