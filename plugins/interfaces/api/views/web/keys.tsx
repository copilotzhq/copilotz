/// <reference lib="dom" />
/**
 * A space's developer keys (kind `api.keys`: its API tab, item `{ _id }`,
 * the space; spaces' `spaceTabs`): what keys are for, the person's own keys
 * there (each with what it does, its first characters, when it was made and
 * last used, its reference, and revoking it, after asking), making one, and
 * trying it with curl. Keys are each person's: nobody sees another's. In a
 * side panel (`hints.mode: "panel"`), the same, compact.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Card,
  CodeBlock,
  Dialog,
  EmptyState,
  Icon,
  message,
  Notice,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { ApiKey, ApiPreset } from "../../contract.ts";
import { CreateDialog, type Presets } from "./create.tsx";
import { Reference } from "./reference.tsx";
import { type Allowed, snippets, summary, VARIABLE } from "./snippet.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Space = { _id: string; name: string; kind?: string };

/** The presets, lowest `order` first, leaving out those taken away. */
const presetsOf = (given: unknown): Presets =>
  Object.entries((given ?? {}) as Record<string, ApiPreset | null>)
    .flatMap(([key, p]) => p?.title ? [[key, p] as [string, ApiPreset]] : [])
    .sort(([a, x], [b, y]) => (x.order ?? 0) - (y.order ?? 0) || a.localeCompare(b));

export const keysView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const keys = ctx.db.collection<ApiKey>("api_key").find({ in: id }, { sort: { at: -1 } }).value;
  const space = ctx.db.collection<Space>("space").findOne({ _id: id }).value;
  const compact = ctx.hints.mode === "panel";
  const style = <style href="api-web" precedence="copilotz">{STYLE}</style>;
  if (keys === undefined || space === undefined) {
    return (
      <div className="api-tab" aria-busy="true">
        {style}
        <Skeleton height={56} radius="xl" />
        <Skeleton height={76} radius="xl" />
      </div>
    );
  }
  if (!space) return null;
  return (
    <>
      {style}
      <Keys
        key={space._id}
        space={space}
        keys={keys}
        presets={presetsOf(ctx.resources.apiPresets)}
        compact={compact}
        call={ctx.call}
      />
    </>
  );
};

function Keys(
  { space, keys, presets, compact, call }: {
    space: Space;
    keys: ApiKey[];
    presets: Presets;
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [making, setMaking] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey>();
  const where = space.kind === "personal" ? "your Personal space" : space.name;
  const known = Object.fromEntries(presets);
  // What to try: what its keys do, or chatting.
  const tried: Allowed = keys[0] ?? {
    actions: presets[0]?.[1].actions ?? ["chat.send"],
    queries: presets[0]?.[1].queries ?? [],
  };
  return (
    <div className={`api-tab${compact ? " api-tab-compact" : ""}`}>
      <section className="api-intro" aria-labelledby="api-keys-title">
        <div className="api-intro-text">
          <h2 className="api-title" id="api-keys-title">Developer keys</h2>
          <p>
            Your code calls the agents in {where}{" "}
            with a key. It acts as you, works only here, and does only what you pick.
          </p>
        </div>
        {keys.length
          ? (
            <Button variant="primary" icon="plus" onClick={() => setMaking(true)}>
              New key
            </Button>
          )
          : null}
      </section>
      {keys.length
        ? (
          <ul className="api-keys" aria-label="Your keys here">
            {keys.map((key) => (
              <KeyRow
                key={key._id}
                apiKey={key}
                what={summary(key, known)}
                onRevoke={() => setRevoking(key)}
              />
            ))}
          </ul>
        )
        : (
          <EmptyState
            icon="terminal"
            tone="primary"
            heading="h3"
            title="No keys here yet"
            action={
              <Button variant="primary" icon="plus" onClick={() => setMaking(true)}>
                Make a key
              </Button>
            }
          >
            Make one for a script, a backend or an automation: it sends messages to the agents here,
            reads the conversations, and follows replies as they're written.
          </EmptyState>
        )}
      {compact ? null : <TryIt allowed={tried} />}
      <CreateDialog
        open={making}
        onClose={() => setMaking(false)}
        space={space._id}
        where={where}
        presets={presets}
        call={call}
      />
      <Revoke apiKey={revoking} onClose={() => setRevoking(undefined)} call={call} />
    </div>
  );
}

function KeyRow(
  { apiKey, what, onRevoke }: { apiKey: ApiKey; what: string; onRevoke(): void },
): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <Card padding="none" className="api-key">
        <div className="api-key-main">
          <span className="api-key-mark" aria-hidden="true">
            <Icon name="lock" size={16} />
          </span>
          <div className="api-key-text">
            <div className="api-key-name">
              <span>{apiKey.name}</span>
              <span className="api-name">{what}</span>
            </div>
            <div className="api-key-meta">
              <code>{apiKey.hint}…</code>
              <span aria-hidden="true">·</span>
              <span>
                Made <Time at={apiKey.at} />
              </span>
              <span aria-hidden="true">·</span>
              {apiKey.used
                ? (
                  <span>
                    Last used <Time at={apiKey.used} />
                  </span>
                )
                : <span>Never used</span>}
            </div>
          </div>
          <div className="api-key-actions">
            <Button
              size="sm"
              variant="ghost"
              iconEnd={open ? "chevron-down" : "chevron"}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              Reference
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={onRevoke}>Revoke</Button>
          </div>
        </div>
        {open
          ? (
            <div className="api-key-ref">
              <Reference allowed={apiKey} />
            </div>
          )
          : null}
      </Card>
    </li>
  );
}

/** Revoking a key, once they've read what it means. */
function Revoke(
  { apiKey, onClose, call }: { apiKey?: ApiKey; onClose(): void; call: Call },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog
      open={!!apiKey}
      onClose={() => {
        setError(undefined);
        onClose();
      }}
      size="sm"
      title={apiKey ? `Revoke “${apiKey.name}”?` : ""}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            onClick={async () => {
              if (!apiKey) return;
              setBusy(true);
              setError(undefined);
              try {
                await call("api_key.revoke", { key: apiKey._id });
                onClose();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Revoke key
          </Button>
        </>
      }
    >
      <p className="api-note">
        Code that uses it stops working at once. You can't undo this: make a new key instead.
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}

/** Trying a key with curl, the key in a variable. */
function TryIt({ allowed }: { allowed: Allowed }): ReactNode {
  const origin = globalThis.location?.origin ?? "";
  return (
    <section className="api-try" aria-labelledby="api-try-title">
      <h3 className="api-sub" id="api-try-title">Try it</h3>
      <p className="api-note">
        With a key in <code>${VARIABLE}</code>, from a terminal:
      </p>
      <div className="api-try-list">
        {snippets(origin, allowed).map((s) => (
          <CodeBlock key={s.title} title={s.title} code={s.code} copy={s.text} />
        ))}
      </div>
      <p className="api-note">
        Errors are JSON, <code>{"{ error: { code, message } }"}</code>. An{" "}
        <code>Idempotency-Key</code>{" "}
        header makes a call safe to send again: the second answers what the first did. Each key's
        reference is at <code>{origin}/api/</code>.
      </p>
    </section>
  );
}
