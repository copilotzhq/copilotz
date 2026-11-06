/**
 * A space's developer keys (kind `api.keys`: its API tab, item `{ _id }`,
 * the space; spaces' `spaceTabs`): what keys are for, the person's own keys
 * there (each with what it may use, how it works there, its first
 * characters, when it was made and last used, its reference, and revoking
 * it, after asking), making one, and trying it with curl. Here, each sees
 * their own keys; everyone's show among the space's members. In a side panel
 * (`hints.mode: "panel"`), the same, compact.
 */
import { type ReactNode, useState } from "react";
import type { Scope, ViewContext } from "../../../../../runtime/mod.ts";
import {
  appBase,
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
import { snippets, summary, VARIABLE } from "./snippet.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Space = { _id: string; name: string; kind?: string };

/** The presets, lowest `order` first, leaving out those taken away. */
export const presetsOf = (given: unknown): Presets =>
  Object.entries((given ?? {}) as Record<string, ApiPreset | null>)
    .flatMap(([key, p]) => p?.title && p.scope ? [[key, p] as [string, ApiPreset]] : [])
    .sort(([a, x], [b, y]) => (x.order ?? 0) - (y.order ?? 0) || a.localeCompare(b));

/** How a key works in its space, in a few words. */
export const roleSaid = (role?: string) => role === "editor" ? "Editor" : "Viewer";

export const keysView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  // Theirs alone: the space's members list everyone's.
  const keys = ctx.db.collection<ApiKey>("api_key").query<ApiKey[]>("mine", { in: id }).value;
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
  const tried: Scope = keys[0]?.scope ?? presets[0]?.[1].scope ?? { call: ["chat.send"] };
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
                what={summary(key.scope ?? {}, known)}
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
      {compact ? null : <TryIt scope={tried} space={space._id} />}
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
              <span>{roleSaid(apiKey.role)} here</span>
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
              <Reference scope={apiKey.scope ?? {}} />
            </div>
          )
          : null}
      </Card>
    </li>
  );
}

/** Revoking a key, once they've read what it means. */
export function Revoke(
  { apiKey, onClose, call, theirs }: {
    apiKey?: ApiKey;
    onClose(): void;
    call: Call;
    /** Whose it is, when it isn't the viewer's: a manager revoking someone's key. */
    theirs?: string;
  },
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
        {theirs
          ? `Code that uses it stops working at once, and it leaves this space. You can't undo this: ${theirs} can make a new key.`
          : "Code that uses it stops working at once. You can't undo this: make a new key instead."}
      </p>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}

/** Trying a key with curl, the key in a variable. */
function TryIt({ scope, space }: { scope: Scope; space: string }): ReactNode {
  const origin = appBase();
  return (
    <section className="api-try" aria-labelledby="api-try-title">
      <h3 className="api-sub" id="api-try-title">Try it</h3>
      <p className="api-note">
        With a key in <code>${VARIABLE}</code>, from a terminal:
      </p>
      <div className="api-try-list">
        {snippets(origin, scope, { space }).map((s) => (
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
