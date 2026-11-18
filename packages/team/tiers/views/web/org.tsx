/**
 * The org's agents (kind `tiers.org`, the org page's Agents section, the web
 * shell's `orgSettings`, at `/org?tab=models`): how hard they think, then who
 * they are.
 *
 * - **The tiers**, as cards side by side: each its name, what it's good for,
 *   what a typical message comes to at this org's prices and how far the
 *   plan's credits go, and each kind of work's model; the org's default
 *   outlined. Owners and admins make one the default in a click (Undo right
 *   after), customize one (a dialog: each kind of work's model and what it
 *   falls back to, its name), duplicate one into a new tier, make one from
 *   nothing, take one away or put it back as it was, and set the highest
 *   tier members may choose. On a plan of credits given once, a heavier
 *   default says how much faster it spends them.
 * - **The team** (team.tsx): the agents every space starts with.
 *
 * Anyone else reads it, and is told who changes it. Everything shown is a
 * watched read (`modelChoice.offered`), so a change shows at once.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "copilotz";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Input,
  LazyView,
  Menu,
  type MenuItem,
  message,
  Notice,
  Select,
  Skeleton,
} from "copilotz/web";
import { runs } from "copilotz/plugins/interfaces/contract";
import type { ModelPick } from "../../../team/contract.ts";
import type { ModelShown, Shown, TierShown } from "../../contract.ts";
import { say } from "./say.ts";
import { STYLE } from "./style.ts";
import { Team, type TeamAgent } from "./team.tsx";
import {
  creditsGo,
  faster,
  modelSaid,
  perReply,
  providerSaid,
  shownSaid,
  unitSaid,
} from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** How long "Undo" stays after a change. */
const UNDO_MS = 12_000;

export const tiersOrgView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const shown = shownSaid(ctx.db.collection("modelChoice").query<Shown>("offered", {}).value);
  // The org's team (team's), when the app lets people make agents.
  const team = ctx.db.collection("agent").query<{ agents: TeamAgent[] }>("team", {}).value;
  const may = runs({
    role: (ctx.hints.role as string | null | undefined) ?? null,
    staff: ctx.hints.staff === true,
  });
  const org = ctx.hints.org as { name?: string; kind?: string } | undefined;
  return (
    <>
      <style href="tiers-web" precedence="copilotz">{STYLE}</style>
      {shown
        ? (
          <OrgAgents
            shown={shown}
            team={team?.agents}
            may={may}
            org={org?.kind === "personal" ? undefined : org?.name}
            call={ctx.call}
          />
        )
        : <Loading />}
    </>
  );
};

function Loading(): ReactNode {
  return (
    <div className="tiers" aria-busy="true">
      <Skeleton height={22} width="55%" />
      <div className="tiers-cards">
        {[0, 1, 2, 3].map((n) => <Skeleton key={n} height={300} radius="xl" />)}
      </div>
      <Skeleton height={220} radius="xl" />
    </div>
  );
}

/** A change just made, and how to take it back. */
type Done = { said: string; tier: string | null };

/** A tier being customized (`name`), or a new one, maybe copied from another. */
type Editing = { name?: string; from?: string; title?: string };

export function OrgAgents(
  { shown, team, may, org, call }: {
    shown: Shown;
    team?: TeamAgent[];
    may: boolean;
    /** The org's name; none for a person's own. */
    org?: string;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<Done>();
  const [editing, setEditing] = useState<Editing>();
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(undefined), UNDO_MS);
    return () => clearTimeout(timer);
  }, [done]);
  if (!shown.tiers.length) {
    return (
      <EmptyState icon="bot" title={say("emptyTitle")}>
        {say("emptyBody")}
      </EmptyState>
    );
  }
  const fallback = shown.tiers.find((t) => t.name === shown.plan) ?? shown.tiers[0];
  const current = shown.org.tier ?? fallback.name;
  const title = (name?: string | null) => shown.tiers.find((t) => t.name === name)?.title;
  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const choose = (tier: string | null, undoing = false) =>
    act(tier ?? "plan", async () => {
      const before = shown.org.tier;
      await call("tiers.choose", { tier });
      setDone(
        undoing ? undefined : {
          said: say("doneSaid", { tier: title(tier ?? shown.plan) ?? "" }),
          tier: before,
        },
      );
    });
  return (
    <div className="tiers">
      <div className="tiers-now">
        <p>
          {say.nodes(shown.org.tier ? "nowOrg" : "nowPlan", { tier: <b>{title(current)}</b> })}{" "}
          {say("nowMore")}
        </p>
        {may && shown.org.tier && shown.plan && shown.org.tier !== shown.plan
          ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "plan"}
              disabled={!!busy}
              onClick={() => void choose(null)}
            >
              {say("backToPlan")}
            </Button>
          )
          : null}
      </div>
      {done
        ? (
          <Notice
            tone="success"
            role="status"
            action={
              <Button
                size="sm"
                onClick={() => void choose(done.tier, true)}
                disabled={!!busy}
              >
                {say("undo")}
              </Button>
            }
          >
            {done.said}
          </Notice>
        )
        : null}
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {may ? null : (
        <Notice tone="neutral" icon="lock">
          {org ? say("onlyRunners", { org }) : say("onlyRunnersHere")}
        </Notice>
      )}
      <ul className="tiers-cards" aria-label={say("tiersLabel")}>
        {shown.tiers.map((tier) => (
          <TierCard
            key={tier.name}
            tier={tier}
            shown={shown}
            current={tier.name === current}
            may={may}
            busy={busy}
            onChoose={() => void choose(tier.name)}
            onEdit={() => setEditing({ name: tier.name })}
            onCopy={() =>
              setEditing({ from: tier.name, title: say("copyOf", { tier: tier.title }) })}
            onRemove={() => void act(tier.name, () => call("tiers.remove", { tier: tier.name }))}
            onRestore={() => void act(tier.name, () => call("tiers.restore", { tier: tier.name }))}
          />
        ))}
        {may
          ? (
            <li className="tier-new">
              <button
                type="button"
                className="tier-new-button"
                onClick={() => setEditing({ from: current, title: "" })}
              >
                <Icon name="plus" size={18} />
                <b>{say("newTier")}</b>
                <span>{say("newTierAbout")}</span>
              </button>
            </li>
          )
          : null}
      </ul>
      {may && shown.removed.length
        ? (
          <p className="tiers-removed">
            <span>{say("takenAway")}</span>
            {shown.removed.map((r) => (
              <Button
                key={r.name}
                size="sm"
                variant="ghost"
                icon="plus"
                loading={busy === r.name}
                onClick={() => void act(r.name, () => call("tiers.restore", { tier: r.name }))}
              >
                {say("addBackTier", { tier: r.title })}
              </Button>
            ))}
          </p>
        )
        : null}
      {may
        ? (
          <div className="tiers-cap">
            <label htmlFor="tiers-cap">{say("capLabel")}</label>
            <Select
              id="tiers-cap"
              size="sm"
              value={shown.org.cap ?? ""}
              disabled={busy === "cap"}
              onChange={(e) =>
                void act("cap", () => call("tiers.cap", { tier: e.target.value || null }))}
            >
              <option value="">{say("capAny")}</option>
              {shown.tiers.map((t) => <option key={t.name} value={t.name}>{t.title}</option>)}
            </Select>
            <span>{say("capNote")}</span>
          </div>
        )
        : null}
      <SpendNote shown={shown} tier={current} />
      <Team shown={shown} team={team} may={may} org={org} tier={current} call={call} />
      <p className="tiers-foot">
        <Icon name="info" size={14} />
        <span>
          {shown.per === "message" ? say("footMessage") : say("footReply")}{" "}
          {say.nodes("footPrices", { budget: <a href="/org?tab=billing">{say("budget")}</a> })}
        </span>
      </p>
      {editing
        ? (
          <TierEditor
            shown={shown}
            team={team}
            editing={editing}
            call={call}
            onClose={() => setEditing(undefined)}
          />
        )
        : null}
    </div>
  );
}

/**
 * What the tier in use means for the plan's credits, when it's worth saying: a
 * plan of credits given once (a trial's) spent faster than the cheapest tier
 * would, or a plan that gives none.
 */
export function SpendNote(
  { shown, tier }: { shown: Shown; tier?: string },
): ReactNode {
  const credits = shown.credits;
  if (!credits) return null;
  if (!credits.amount) {
    return (
      <Notice
        tone="warning"
        icon="info"
        action={
          <Button size="sm" variant="outline" href="/org?tab=billing">{say("billing")}</Button>
        }
      >
        <b>{say("noCredits", { plan: credits.title })}</b> {say("noCreditsMore")}
      </Notice>
    );
  }
  if (credits.every !== "once") return null;
  const using = shown.tiers.find((t) => t.name === (tier ?? shown.now?.tier));
  const cheapest = shown.tiers.reduce<TierShown | undefined>(
    (low, t) => t.price !== null && (!low || (low.price ?? Infinity) > t.price) ? t : low,
    undefined,
  );
  if (!using || !cheapest || using.name === cheapest.name) return null;
  const times = faster(using.price, cheapest.price);
  if (!times) return null;
  const goes = creditsGo(credits, using.price, shown.per);
  return (
    <Notice tone="warning" icon="info" className="tiers-spend">
      <b>{say("faster", { tier: using.title, times, cheapest: cheapest.title })}</b>{" "}
      {goes ? `${say("fasterGoes", { goes })} ` : ""}
      {say("changeAnyTime")}
    </Notice>
  );
}

/** A tier: what it's for, what a message comes to, each kind of work's model, and choosing it. */
export function TierCard(
  { tier, shown, current, may, busy, onChoose, onEdit, onCopy, onRemove, onRestore }: {
    tier: TierShown;
    shown: Shown;
    /** It's the org's default. */
    current: boolean;
    may: boolean;
    busy?: string;
    onChoose(): void;
    onEdit(): void;
    onCopy(): void;
    onRemove(): void;
    onRestore(): void;
  },
): ReactNode {
  const price = perReply(tier.price);
  const goes = creditsGo(shown.credits, tier.price, shown.per);
  const kindTitle = (kind: string) => shown.kinds.find((k) => k.kind === kind)?.title ?? kind;
  const items: (MenuItem | "separator")[] = [
    { label: say("customize"), icon: "pencil", onSelect: onEdit },
    { label: say("duplicate"), icon: "copy", onSelect: onCopy },
    ...(tier.changed
      ? [{ label: say("backToOriginal"), icon: "restore" as const, onSelect: onRestore }]
      : []),
    ...(shown.tiers.length > 1
      ? [
        "separator" as const,
        {
          label: tier.made ? say("deleteTier") : say("takeAway"),
          icon: "trash" as const,
          tone: "destructive" as const,
          onSelect: onRemove,
        },
      ]
      : []),
  ];
  return (
    <Card
      as="li"
      className="tier-card"
      data-current={current ? true : undefined}
      aria-current={current ? "true" : undefined}
      aria-labelledby={`tier-${tier.name}`}
    >
      <div className="tier-card-top">
        <h3 id={`tier-${tier.name}`}>{tier.title}</h3>
        <span className="tier-card-badges">
          {current
            ? (
              <Badge tone="primary">
                <Icon name="check" size={12} />
                {say("badgeDefault")}
              </Badge>
            )
            : tier.name === shown.plan
            ? <Badge variant="outline">{say("badgePlan")}</Badge>
            : null}
          {tier.made ? <Badge variant="outline">{say("badgeYours")}</Badge> : null}
          {tier.changed ? <Badge variant="outline">{say("badgeChanged")}</Badge> : null}
          {may
            ? <Menu label={say("tierMore", { tier: tier.title })} align="end" items={items} />
            : null}
        </span>
      </div>
      {tier.description ? <p className="tier-card-for">{tier.description}</p> : null}
      <p className="tier-card-price">
        {price
          ? (
            <>
              <b>{price}</b> {unitSaid(shown.per)}
            </>
          )
          : say("pricedEach")}
      </p>
      <p className="tier-card-goes">{goes ? goes[0].toUpperCase() + goes.slice(1) : null}</p>
      <ul className="tier-card-agents" aria-label={say("tierModels", { tier: tier.title })}>
        {tier.kinds.map(({ kind, model }) => (
          <li key={kind}>
            <span className="tier-who">{kindTitle(kind)}</span>
            <span className="tier-model">
              {model.name}
              {thenSaid(model) ? <small>{say("then", { names: thenSaid(model)! })}</small> : null}
            </span>
          </li>
        ))}
      </ul>
      {may
        ? (
          <div className="tier-card-end">
            {current
              ? (
                <p className="tier-card-using">
                  <Icon name="check" size={15} /> {say("defaultForNew")}
                </p>
              )
              : (
                <Button
                  loading={busy === tier.name}
                  disabled={!!busy}
                  onClick={onChoose}
                  aria-describedby={`tier-${tier.name}`}
                >
                  {say("makeDefault")}
                </Button>
              )}
          </div>
        )
        : null}
    </Card>
  );
}

/** A chain as it's edited: model ids, in order; the first is the model, the rest its fallbacks. */
type Chain = string[];

const chainOf = (model?: ModelShown): Chain =>
  model ? [model.id, ...(model.fallbacks ?? []).map((f) => f.id)] : [];

/**
 * Customizing a tier, or making one (a dialog): its name and what it's for,
 * then each kind of work, with the agents that do it, its model and what it
 * falls back to (team's picker, `model.pick`), and adding a kind of work of
 * the org's own. Saved at once (`tiers.save`): only the kinds changed.
 */
function TierEditor(
  { shown, team, editing, call, onClose }: {
    shown: Shown;
    team?: TeamAgent[];
    editing: Editing;
    call: Call;
    onClose(): void;
  },
): ReactNode {
  const tier = editing.name ? shown.tiers.find((t) => t.name === editing.name) : undefined;
  const base = tier ?? shown.tiers.find((t) => t.name === editing.from) ?? shown.tiers[0];
  const making = !tier;
  const [title, setTitle] = useState(tier?.title ?? editing.title ?? "");
  const [description, setDescription] = useState(tier?.description ?? "");
  const [chains, setChains] = useState<Record<string, Chain>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState<{ title: string; base: string }>();
  // Names for models chosen here, until the page shows them.
  const [names, setNames] = useState<Record<string, string>>({});
  const known = new Map<string, string>();
  for (const t of shown.tiers) {
    for (const k of t.kinds) {
      known.set(k.model.id, k.model.name);
      for (const f of k.model.fallbacks ?? []) known.set(f.id, f.name);
    }
  }
  const nameOf = (id: string) => known.get(id) ?? names[id] ?? id.slice(id.indexOf("/") + 1);
  const chainFor = (kind: string) =>
    chains[kind] ?? chainOf(base?.kinds.find((k) => k.kind === kind)?.model);
  const set = (kind: string, chain: Chain) => setChains((had) => ({ ...had, [kind]: chain }));
  const agentsOf = (kind: string) => [
    ...(shown.kinds.find((k) => k.kind === kind)?.agents.map((a) => a.name) ?? []),
    ...(team ?? []).filter((a) => !a.off && a.kind === "org" && a.like === kind).map((a) => a.name),
  ];
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call("tiers.save", {
        ...(tier ? { tier: tier.name } : { from: base?.name }),
        ...(title.trim() && title.trim() !== tier?.title ? { title: title.trim() } : {}),
        ...(description.trim() !== (tier?.description ?? "")
          ? { description: description.trim() }
          : {}),
        ...(Object.keys(chains).length ? { kinds: chains } : {}),
      });
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const addKind = async () => {
    if (!adding?.title.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await call("tiers.kind", { title: adding.title.trim(), base: adding.base });
      setAdding(undefined);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const appKinds = shown.kinds.filter((k) => !k.base);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={making ? say("newTierTitle") : say("customizeTitle", { tier: tier.title })}
      description={making
        ? say("newTierStarts", { tier: base?.title ?? "" })
        : say("customizeAbout")}
      footer={
        <>
          {error ? <span className="tiers-editor-error" role="alert">{error}</span> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>{say("cancel")}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={making && !title.trim()}
            onClick={() => void save()}
          >
            {making ? say("createTier") : say("save")}
          </Button>
        </>
      }
    >
      <div className="tiers-editor">
        <div className="tiers-editor-names">
          <Field label={say("name")}>
            {(control) => (
              <Input
                {...control}
                value={title}
                maxLength={40}
                placeholder={say("namePlaceholder")}
                autoFocus={making}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Field>
          <Field label={say("forLabel")}>
            {(control) => (
              <Input
                {...control}
                value={description}
                maxLength={200}
                placeholder={say("forPlaceholder")}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
        </div>
        <ol className="tiers-kinds">
          {shown.kinds.map((kind) => {
            const chain = chainFor(kind.kind);
            const who = agentsOf(kind.kind);
            return (
              <li key={kind.kind} className="tiers-kind">
                <div className="tiers-kind-head">
                  <b>{kind.title}</b>
                  <span>{who.length ? who.join(", ") : say("nobodyYet")}</span>
                  {chains[kind.kind]
                    ? <Badge variant="outline">{say("badgeChanged")}</Badge>
                    : null}
                </div>
                <ChainEditor
                  chain={chain}
                  nameOf={nameOf}
                  onName={(id, name) => setNames((had) => ({ ...had, [id]: name }))}
                  onChange={(next) => set(kind.kind, next)}
                />
              </li>
            );
          })}
        </ol>
        {adding
          ? (
            <div className="tiers-kind-new">
              <Field label={say("newKind")}>
                {(control) => (
                  <Input
                    {...control}
                    value={adding.title}
                    maxLength={40}
                    placeholder={say("newKindPlaceholder")}
                    autoFocus
                    onChange={(e) => setAdding({ ...adding, title: e.target.value })}
                  />
                )}
              </Field>
              <Field label={say("startsFrom")}>
                {(control) => (
                  <Select
                    {...control}
                    value={adding.base}
                    onChange={(e) => setAdding({ ...adding, base: e.target.value })}
                  >
                    {appKinds.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}
                  </Select>
                )}
              </Field>
              <div className="tiers-kind-new-end">
                <Button size="sm" variant="ghost" onClick={() => setAdding(undefined)}>
                  {say("cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!adding.title.trim() || busy}
                  onClick={() => void addKind()}
                >
                  {say("add")}
                </Button>
              </div>
            </div>
          )
          : (
            <Button
              size="sm"
              variant="ghost"
              icon="plus"
              onClick={() => setAdding({ title: "", base: appKinds[0]?.kind ?? "" })}
            >
              {say("addKind")}
            </Button>
          )}
      </div>
    </Dialog>
  );
}

/**
 * A model chain: the model (team's picker), then what's tried when it fails,
 * each with Move up, Move down and Remove, and Add a fallback.
 */
function ChainEditor(
  { chain, nameOf, onName, onChange }: {
    chain: Chain;
    nameOf(id: string): string;
    onName(id: string, name: string): void;
    onChange(chain: Chain): void;
  },
): ReactNode {
  const [first, ...rest] = chain;
  const moved = (from: number, to: number) => {
    const next = [...rest];
    const [one] = next.splice(from, 1);
    next.splice(to, 0, one);
    return [first, ...next];
  };
  const pick = (onPick: (model: string) => void): ModelPick => ({
    onPick: (model: string) => {
      onName(model, model.slice(model.indexOf("/") + 1));
      onPick(model);
      return Promise.resolve();
    },
  });
  return (
    <div className="tiers-chain">
      <LazyView
        kind="model.pick"
        item={{ value: first ?? "" }}
        hints={pick((model) => onChange([model, ...rest.filter((id) => id !== model)]))}
        fallback={<Skeleton height={54} />}
      />
      <div className="tiers-fallbacks">
        <p className="tiers-fallbacks-head">{say("fallbacks")}</p>
        {rest.length
          ? (
            <ol className="tiers-fallbacks-list">
              {rest.map((id, i) => (
                <li key={`${id}:${i}`}>
                  <span className="tiers-fallback-name">
                    <b>{nameOf(id)}</b>
                    <small>{providerSaid(id)}</small>
                  </span>
                  <Menu
                    label={say("tierMore", { tier: nameOf(id) })}
                    align="end"
                    items={[
                      ...(i > 0
                        ? [{ label: say("moveUp"), onSelect: () => onChange(moved(i, i - 1)) }]
                        : []),
                      ...(i < rest.length - 1
                        ? [{ label: say("moveDown"), onSelect: () => onChange(moved(i, i + 1)) }]
                        : []),
                      {
                        label: say("remove"),
                        icon: "trash" as const,
                        tone: "destructive" as const,
                        onSelect: () => onChange([first, ...rest.filter((_, j) => j !== i)]),
                      },
                    ]}
                  />
                </li>
              ))}
            </ol>
          )
          : <p className="tiers-fallbacks-none">{say("noFallback")}</p>}
        <LazyView
          kind="model.pick"
          item={{ value: "" }}
          hints={{
            ...pick((model) => onChange([first, ...rest.filter((id) => id !== model), model])),
            look: "link",
            label: say("addFallback"),
            disabled: rest.length >= 7,
          } satisfies ModelPick}
          fallback={null}
        />
      </div>
    </div>
  );
}

/** What a model falls back to, each name once: "GPT-6 Luna, Claude Haiku 5.5". */
export function thenSaid(model: ModelShown): string | undefined {
  const names = [...new Set((model.fallbacks ?? []).map((f) => f.name))]
    .filter((name) => name !== model.name);
  return names.length ? names.join(", ") : undefined;
}

/** A model as a short line: "Claude Haiku 5.5, low effort, then GPT-6 Luna". */
export const modelLine = (model: ModelShown): string =>
  `${modelSaid(model)}${thenSaid(model) ? `, then ${thenSaid(model)}` : ""}`;
