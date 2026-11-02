/**
 * Gift codes in staff's console (at `/console?tab=codes`): making one (how many
 * dollars of credits, when they lapse, the last day it can be claimed, what
 * it's for), which shows the code just this once, with a way to copy it and a
 * clear word that it won't be shown again, since only its hash is kept. Then
 * every code, newest first: how much, for what, where it stands, which org
 * claimed it; and taking back one nobody has claimed.
 */
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  Badge,
  Button,
  type ConsoleOrg,
  CopyButton,
  createGiftCode,
  Dialog,
  EmptyState,
  Field,
  type GiftCode,
  giftCodes,
  Input,
  message,
  Notice,
  revokeGiftCode,
  Skeleton,
  Time,
} from "../../../../hosts/web/mod.ts";
import { codeStatus, dayOf, dollarsOf, newCodeOf, STATUS } from "../shared/codes.ts";

const STYLE = `
.console-tabs { display: flex; margin-bottom: 18px; }
.codes { container: codes / inline-size; display: grid; gap: 14px; }
.codes-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.codes-tools p { margin: 0; color: var(--muted-foreground); font-size: 13px; }
.codes-list { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--card); overflow: hidden; }
.codes-row { display: grid; grid-template-columns: 96px minmax(0, 1fr) minmax(120px, .8fr) 104px; align-items: center;
  gap: 8px 16px; min-height: 56px; padding: 10px 14px; }
.codes-row + .codes-row { border-top: 1px solid var(--border); }
.codes-amount { font-family: var(--font-display); font-size: 17px; font-weight: 650; letter-spacing: -.01em;
  font-variant-numeric: tabular-nums; }
.codes-what { display: grid; gap: 1px; min-width: 0; font-size: 13.5px; line-height: 1.4; }
.codes-what code { color: var(--secondary-foreground); font-size: 12px; }
.codes-what small { color: var(--muted-foreground); font-size: 12.5px; }
.codes-note { overflow: hidden; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
.codes-end { display: flex; justify-content: flex-end; }
.codes-status { display: grid; justify-items: start; gap: 2px; min-width: 0; color: var(--muted-foreground); font-size: 12.5px; }
.codes-status span:last-child { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.codes-form { display: grid; gap: 14px; }
.codes-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px; align-items: start; }
.codes-money::before { content: "$"; color: var(--muted-foreground); font-size: 14.5px; }
.codes-shown { display: flex; align-items: center; gap: 6px; padding: 12px 8px 12px 14px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--muted); }
.codes-shown code { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 14.5px; font-weight: 600; line-height: 1.5;
  overflow-wrap: anywhere; user-select: all; }
.codes-once { display: grid; gap: 12px; }
.codes-text { margin: 0; color: var(--secondary-foreground); font-size: 14px; line-height: 1.55; }
@container codes (max-width: 620px) {
  .codes-row { grid-template-columns: minmax(0, 1fr) auto; min-height: 0; }
  .codes-what { grid-column: 1 / -1; grid-row: 2; }
  .codes-status { grid-column: 1; grid-row: 3; }
  .codes-end { grid-column: 2; grid-row: 1; }
}
@media (max-width: 480px) {
  .codes-two { grid-template-columns: minmax(0, 1fr); }
}
`;

export function GiftCodes({ orgs, ready }: { orgs: ConsoleOrg[]; ready: boolean }): ReactNode {
  const [codes, setCodes] = useState<GiftCode[]>();
  const [error, setError] = useState<string>();
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<{ code: string; amount: number }>();
  const [revoking, setRevoking] = useState<GiftCode>();
  const load = async () => {
    try {
      setCodes(await giftCodes());
      setError(undefined);
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    if (ready) void load();
  }, [ready]);
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;
  return (
    <div className="codes">
      <style href="console-codes" precedence="copilotz">{STYLE}</style>
      <div className="codes-tools">
        <p>
          {codes
            ? `${codes.length} ${codes.length === 1 ? "code" : "codes"}, the newest first`
            : " "}
        </p>
        <Button variant="primary" icon="plus" onClick={() => setMaking(true)}>New gift code</Button>
      </div>
      {error && !codes
        ? (
          <Notice
            tone="destructive"
            role="alert"
            action={<Button size="sm" onClick={() => void load()}>Try again</Button>}
          >
            {error}
          </Notice>
        )
        : null}
      {!codes && !error
        ? (
          <div className="codes-list" aria-busy="true">
            {[0, 1, 2].map((i) => <Skeleton key={i} height={56} radius="sm" />)}
          </div>
        )
        : null}
      {codes && !codes.length
        ? (
          <EmptyState
            icon="star"
            title="No gift codes yet"
            action={<Button icon="plus" onClick={() => setMaking(true)}>New gift code</Button>}
          >
            A gift code gives whoever claims it credits for their org.
          </EmptyState>
        )
        : null}
      {codes?.length
        ? (
          <ul className="codes-list">
            {codes.map((code) => (
              <Row
                key={code.id}
                code={code}
                orgName={orgName}
                onRevoke={() => setRevoking(code)}
              />
            ))}
          </ul>
        )
        : null}
      <NewCode
        open={making}
        close={() => setMaking(false)}
        onMade={(code, amount) => {
          setMaking(false);
          setMade({ code, amount });
          void load();
        }}
      />
      <ShownOnce made={made} close={() => setMade(undefined)} />
      <Revoke
        code={revoking}
        close={() => setRevoking(undefined)}
        onDone={() => {
          setRevoking(undefined);
          void load();
        }}
      />
    </div>
  );
}

function Row(
  { code, orgName, onRevoke }: {
    code: GiftCode;
    orgName(id: string): string;
    onRevoke(): void;
  },
): ReactNode {
  const status = codeStatus(code);
  const { label, tone } = STATUS[status];
  const terms = [
    code.expires ? `Credits lapse ${dayOf(code.expires)}` : "Credits don't lapse",
    status === "waiting" && code.until ? `claim by ${dayOf(code.until)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="codes-row">
      <span className="codes-amount">{dollarsOf(code.amount)}</span>
      <span className="codes-what">
        {code.note ? <span className="codes-note" title={code.note}>{code.note}</span> : null}
        <small>{terms}</small>
        <small>
          <code title="Only the start of what's kept: it can't be claimed with this">
            {code.short}
          </code>{" "}
          · made <Time at={code.at} />
        </small>
      </span>
      <span className="codes-status">
        <Badge tone={tone === "neutral" ? undefined : tone}>{label}</Badge>
        {code.org
          ? (
            <span title={code.org}>
              by {orgName(code.org)}, {code.claimed ? dayOf(code.claimed) : ""}
            </span>
          )
          : null}
      </span>
      <span className="codes-end">
        {status === "waiting" ? <Button size="sm" onClick={onRevoke}>Take back</Button> : null}
      </span>
    </li>
  );
}

const EMPTY = { amount: "", expires: "", until: "", note: "" };

function NewCode(
  { open, close, onMade }: {
    open: boolean;
    close(): void;
    onMade(code: string, amount: number): void;
  },
): ReactNode {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setBusy(false);
    setError(undefined);
  }, [open]);
  const asked = newCodeOf(form);
  const ready = !("error" in asked);
  const set = (field: keyof typeof EMPTY) => (event: { target: { value: string } }) =>
    setForm((now) => ({ ...now, [field]: event.target.value }));
  const go = async (event?: FormEvent) => {
    event?.preventDefault();
    if ("error" in asked || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { code } = await createGiftCode(asked);
      onMade(code, asked.amount);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="New gift code"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void go()}>
            {ready ? `Make a ${dollarsOf(asked.amount)} code` : "Make the code"}
          </Button>
        </>
      }
    >
      <form className="codes-form" onSubmit={(event) => void go(event)}>
        <Field label="Credits">
          {(control) => (
            <Input
              {...control}
              autoFocus
              inputMode="decimal"
              placeholder="25"
              className="codes-money"
              value={form.amount}
              onChange={set("amount")}
            />
          )}
        </Field>
        <div className="codes-two">
          <Field label="Credits lapse on" hint="Empty: they don't lapse.">
            {(control) => (
              <Input {...control} type="date" value={form.expires} onChange={set("expires")} />
            )}
          </Field>
          <Field label="Claim by" hint="Empty: any time.">
            {(control) => (
              <Input {...control} type="date" value={form.until} onChange={set("until")} />
            )}
          </Field>
        </div>
        <Field label="What it's for" hint="Whoever claims it sees this in their history.">
          {(control) => (
            <Input
              {...control}
              maxLength={200}
              placeholder="Conference, November"
              value={form.note}
              onChange={set("note")}
            />
          )}
        </Field>
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

/** The code, just this once. */
function ShownOnce(
  { made, close }: { made?: { code: string; amount: number }; close(): void },
): ReactNode {
  return (
    <Dialog
      open={!!made}
      onClose={close}
      title={made ? `Your ${dollarsOf(made.amount)} gift code` : ""}
      footer={<Button variant="primary" onClick={close}>Done, I've kept it</Button>}
    >
      {made
        ? (
          <div className="codes-once">
            <div className="codes-shown">
              <code>{made.code}</code>
              <CopyButton text={made.code} label="Copy the code" />
            </div>
            <Notice tone="warning" title="This won't be shown again">
              Only a fingerprint of it is kept, so nobody can look it up later. Copy it now. If it's
              lost, take this one back and make another.
            </Notice>
          </div>
        )
        : null}
    </Dialog>
  );
}

function Revoke(
  { code, close, onDone }: { code?: GiftCode; close(): void; onDone(): void },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setBusy(false);
    setError(undefined);
  }, [code]);
  return (
    <Dialog
      open={!!code}
      onClose={close}
      size="sm"
      title={code ? `Take back this ${dollarsOf(code.amount)} code?` : ""}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            loading={busy}
            onClick={async () => {
              if (!code) return;
              setBusy(true);
              try {
                await revokeGiftCode(code.id);
                onDone();
              } catch (e) {
                setError(message(e));
                setBusy(false);
              }
            }}
          >
            Take it back
          </Button>
        </>
      }
    >
      <p className="codes-text">
        Nobody can claim it after this, and that can't be undone. If someone still needs it, make
        them a new one.
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}
