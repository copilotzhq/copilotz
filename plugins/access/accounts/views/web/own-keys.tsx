/**
 * The person's own API keys, on the Connected accounts page: for any provider
 * a key can be brought for, theirs alone (`modelKey.set { mine }`): agents
 * working for them use it for that provider's models, before the org's key and
 * the app's, and the org isn't charged for those calls. Each key shows its
 * last characters, and where the org's tiers use that provider's models
 * ("Used for Decides and Checks on Everyday"), or that none does yet, so a key
 * that would sit unused says so. Removing one is in place.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Card,
  Field,
  Input,
  message,
  Notice,
  Select,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A key of the person's, as `modelKey.mine` answers: its provider and last characters. */
type OwnKey = { provider: string; hint?: string; at?: string };
/** A provider, as `models.offered {}` lists it. */
type Provider = { id: string; name: string; keyed: boolean };
/** What the tiers show, as far as keys go: each tier's chain by kind of work. */
type Tiers = {
  tiers: {
    name: string;
    title: string;
    kinds: { kind: string; model: { id: string; fallbacks?: { id: string }[] } }[];
  }[];
  kinds: { kind: string; title: string }[];
  now: { tier: string } | null;
};

export const ownKeysView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const mine = ctx.db.collection("modelKey").query<OwnKey[]>("mine", {}).value;
  // Where the tiers use each provider (their front end says where to read them: `agentKinds`).
  const asked = !!(ctx.resources.agentKinds as { query?: string } | undefined)?.query;
  const tiers = asked
    ? ctx.db.collection("modelChoice").query<Tiers>("offered", {}).value
    : undefined;
  if (!mine || (asked && !tiers)) return <Skeleton height={120} radius="xl" />;
  return <OwnKeys mine={mine} tiers={tiers} call={ctx.call} />;
};

/** Where the org's default tier uses a provider's models: "Decides and Checks on Everyday". */
function usedFor(tiers: Tiers | undefined, provider: string): string | undefined {
  if (!tiers?.now) return undefined;
  const tier = tiers.tiers.find((t) => t.name === tiers.now!.tier);
  if (!tier) return undefined;
  const ours = (id: string) => id.startsWith(`${provider}/`);
  const kinds = tier.kinds.filter((k) =>
    ours(k.model.id) || (k.model.fallbacks ?? []).some((f) => ours(f.id))
  ).map((k) => tiers.kinds.find((t) => t.kind === k.kind)?.title ?? k.kind);
  if (!kinds.length) return undefined;
  const list = kinds.length === 1
    ? kinds[0]
    : `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}`;
  return `Used for ${list} on ${tier.title}`;
}

function OwnKeys(
  { mine, tiers, call }: { mine: OwnKey[]; tiers?: Tiers; call: Call },
): ReactNode {
  const [providers, setProviders] = useState<Provider[]>();
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const nameOf = (id: string) => providers?.find((p) => p.id === id)?.name ?? id;
  const open = async () => {
    setAdding(true);
    setError(undefined);
    if (providers) return;
    try {
      const listed = await call<{ providers: Provider[] }>("models.offered", {});
      const keyed = listed.providers.filter((p) => p.keyed);
      setProviders(keyed);
      setProvider(keyed[0]?.id ?? "");
    } catch (e) {
      setError(message(e));
    }
  };
  const save = async () => {
    if (!provider || key.trim().length < 8) return;
    setBusy("save");
    setError(undefined);
    try {
      await call("modelKey.set", { provider, key: key.trim(), mine: true });
      setKey("");
      setAdding(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async (id: string) => {
    setBusy(id);
    setError(undefined);
    try {
      await call("modelKey.remove", { provider: id, mine: true });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Card as="section" className="own-keys" aria-labelledby="own-keys">
      <header className="own-keys-head">
        <div>
          <h2 id="own-keys">Your own API keys</h2>
          <p>
            Agents working for you use your key for that provider's models, before your org's. Your
            org isn't charged for those calls, and nobody else can use it.
          </p>
        </div>
        {adding
          ? null
          : (
            <Button size="sm" variant="secondary" icon="plus" onClick={() => void open()}>
              Add a key
            </Button>
          )}
      </header>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {mine.length
        ? (
          <ul className="own-keys-list">
            {mine.map((k) => {
              const used = usedFor(tiers, k.provider);
              return (
                <li key={k.provider}>
                  <div className="own-keys-text">
                    <b>{nameOf(k.provider)}</b>
                    <span className="own-keys-hint">{k.hint ?? "••••"}</span>
                    <span className="own-keys-used" data-unused={used ? undefined : true}>
                      {used ?? (tiers
                        ? "No tier your org uses runs this provider's models yet."
                        : "Used for this provider's models.")}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === k.provider}
                    onClick={() => void remove(k.provider)}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )
        : adding
        ? null
        : <p className="own-keys-none">No keys of your own.</p>}
      {adding
        ? (
          <form
            className="own-keys-add"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Provider">
              {(control) =>
                providers
                  ? (
                    <Select
                      {...control}
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  )
                  : <Skeleton height={36} />}
            </Field>
            <Field label="API key" hint="Kept sealed; only its last characters are ever shown.">
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-…"
                />
              )}
            </Field>
            <div className="own-keys-end">
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button
                type="submit"
                variant="primary"
                loading={busy === "save"}
                disabled={!provider || key.trim().length < 8}
              >
                Save key
              </Button>
            </div>
          </form>
        )
        : null}
    </Card>
  );
}
