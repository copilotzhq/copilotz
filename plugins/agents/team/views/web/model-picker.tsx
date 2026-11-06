/**
 * Choosing the model an agent thinks with, from every provider the app can
 * reach (`models.offered`, from the models.dev catalog). Closed, it shows
 * what's chosen, and says so when it can't run yet; or, where a line already
 * says what's chosen (`look: "link"`), it's just a small "Change". Open, a dialog: search
 * across providers and models, or browse the providers, those ready first, and
 * then one's models, newest first, with what each costs and can do. A provider
 * without a key asks for one: the org's owners and admins add it here
 * (`modelKey.set`), and it's never shown again; anyone else is told whom to ask.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Badge,
  Button,
  Dialog,
  formatNumber,
  Icon,
  IconButton,
  Input,
  message,
  Notice,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import type { OfferedModel, OfferedProvider } from "../../../../models/contract.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** How long after typing it searches. */
const TYPING_MS = 180;

/** Tokens, shortly: `200K`, `1M`. */
const tokens = (count: number) =>
  count >= 1_000
    ? formatNumber(count, {
      notation: "compact",
      maximumFractionDigits: count >= 1_000_000 ? 1 : 0,
    })
    : formatNumber(count);

/** Dollars, in the page's language; the currency stays. */
const usd = (amount: number) =>
  formatNumber(+amount.toFixed(amount < 1 ? 3 : 2), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });

/**
 * What a model costs, per million tokens in and out; nothing, when it says so. On
 * the org's own key it's its provider's to charge, and uses none of the org's
 * credits, which is worth knowing before choosing it.
 */
function priced({ price, ownKey }: OfferedModel): string | undefined {
  if (price?.input === undefined || price.output === undefined) return undefined;
  if (!price.input && !price.output) return say("noCreditsUsed");
  const per = say("priceLine", { input: usd(price.input), output: usd(price.output) });
  return ownKey ? say("priceOwnKey", { price: per }) : per;
}

/** What a kind of input is called. */
const media = (kind: string): string =>
  kind === "image"
    ? say("mediaImage")
    : kind === "pdf"
    ? say("mediaPdf")
    : kind === "audio"
    ? say("mediaAudio")
    : kind === "video"
    ? say("mediaVideo")
    : kind;

/** What a model can do, in a line. */
function abilities(model: OfferedModel): string[] {
  return [
    ...(model.context ? [say("contextSize", { size: tokens(model.context) })] : []),
    ...(model.input ?? []).map(media),
    ...(model.reasons ? [say("reasoning")] : []),
  ];
}

export function ModelPicker(
  { value, onChange, call, disabled, id, look = "field", label }: {
    value: string;
    onChange(model: string): void;
    call: Call;
    disabled?: boolean;
    id?: string;
    /** A field showing what's chosen (the default), or a small button saying `label` ("Change"). */
    look?: "field" | "link";
    label?: string;
  },
): ReactNode {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<
    { model: OfferedModel | null; provider: OfferedProvider | null }
  >();
  // What's chosen, by name, for the field; a link leaves that to the line it's on.
  const load = useCallback(() => {
    if (!value || look === "link") return setChosen(undefined);
    call<{ model: OfferedModel | null; provider: OfferedProvider | null }>("models.offered", {
      model: value,
    }).then(setChosen, () => setChosen(undefined));
  }, [value, call, look]);
  useEffect(load, [load]);
  // Known and not ready: nothing can reach it until its key is added.
  const stuck = chosen?.provider && !chosen.provider.ready;
  const dialog = open
    ? createPortal(
      <Dialog
        open
        onClose={() => {
          setOpen(false);
          load();
        }}
        title={say("chooseModel")}
        className="model-dialog"
      >
        <Choosing
          value={value}
          call={call}
          onChoose={(model) => {
            onChange(model);
            setOpen(false);
          }}
        />
      </Dialog>,
      document.body,
    )
    : null;
  if (look === "link") {
    return (
      <>
        <Button
          id={id}
          variant="link"
          size="sm"
          className="model-change"
          disabled={disabled}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {label ?? say("change")}
        </Button>
        {dialog}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        id={id}
        className="model-chosen"
        disabled={disabled}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="model-chosen-text">
          <b>{chosen?.model?.name ?? (value || say("chooseModel"))}</b>
          <span>
            {chosen?.provider?.name}
            {chosen?.model && priced(chosen.model) ? ` · ${priced(chosen.model)}` : ""}
          </span>
        </span>
        {stuck ? <Badge tone="warning">{say("needsKey")}</Badge> : null}
        <Icon name="selector" size={16} />
      </button>
      {/* Outside the page: the form this is in mustn't hear what's typed or pressed in it. */}
      {dialog}
    </>
  );
}

type Listing = { providers: OfferedProvider[]; set: boolean };
type Found = { providers: OfferedProvider[]; models: OfferedModel[] };

/** What's in the dialog: the search, then what it found, the providers, or one provider. */
function Choosing(
  { value, call, onChoose }: { value: string; call: Call; onChoose(model: string): void },
): ReactNode {
  const [listing, setListing] = useState<Listing>();
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<Found>();
  const [at, setAt] = useState<string>();
  const [error, setError] = useState<string>();
  const list = useCallback(() => {
    call<Listing>("models.offered", {}).then(setListing, (e) => setError(message(e)));
  }, [call]);
  useEffect(list, [list]);

  // The last search asked is the one that shows.
  const asked = useRef(0);
  useEffect(() => {
    const search = typed.trim();
    const mine = ++asked.current;
    if (!search) return setFound(undefined);
    const timer = setTimeout(() => {
      call<Found>("models.offered", { search }).then(
        (answer) => mine === asked.current && setFound(answer),
        (e) => mine === asked.current && setError(message(e)),
      );
    }, TYPING_MS);
    return () => clearTimeout(timer);
  }, [typed, call]);

  if (at) {
    return (
      <ProviderModels
        id={at}
        value={value}
        call={call}
        may={!!listing?.set}
        onBack={() => {
          setAt(undefined);
          list();
        }}
        onChoose={onChoose}
      />
    );
  }
  return (
    <div className="model-choose">
      <Input
        icon="search"
        placeholder={say("searchModels")}
        aria-label={say("searchModels")}
        value={typed}
        autoFocus
        onChange={(event) => setTyped(event.target.value)}
      />
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {typed.trim()
        ? <Results found={found} value={value} onProvider={setAt} onChoose={onChoose} />
        : <Providers listing={listing} onProvider={setAt} />}
    </div>
  );
}

const Loading = () => (
  <div className="model-list" aria-busy="true">
    {[0, 1, 2, 3].map((n) => <Skeleton key={n} height={46} />)}
  </div>
);

function ProviderRow(
  { provider, onOpen }: { provider: OfferedProvider; onOpen(): void },
): ReactNode {
  return (
    <li>
      <button type="button" className="model-row" onClick={onOpen}>
        <span className="model-row-text">
          <b>{provider.name}</b>
          <span>
            {say("providerModels", { count: provider.models })}
            {provider.note ? ` · ${provider.note}` : ""}
          </span>
        </span>
        {provider.hint ? <Badge tone="primary">{say("yourKey")}</Badge> : null}
        <Icon name="chevron" size={15} />
      </button>
    </li>
  );
}

/** The providers: those that can be used now, then those that take a key. */
export function Providers(
  { listing, onProvider }: { listing?: Listing; onProvider(id: string): void },
): ReactNode {
  if (!listing) return <Loading />;
  const ready = listing.providers.filter((p) => p.ready);
  const others = listing.providers.filter((p) => !p.ready);
  return (
    <div className="model-groups">
      {ready.length
        ? (
          <section>
            <h3 className="model-group">{say("readyToUse")}</h3>
            <ul className="model-list">
              {ready.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  onOpen={() => onProvider(p.id)}
                />
              ))}
            </ul>
          </section>
        )
        : null}
      {others.length
        ? (
          <section>
            <h3 className="model-group">{say("withOwnKey")}</h3>
            <ul className="model-list">
              {others.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  onOpen={() => onProvider(p.id)}
                />
              ))}
            </ul>
          </section>
        )
        : null}
    </div>
  );
}

export function ModelRow(
  { model, value, withProvider, onChoose }: {
    model: OfferedModel;
    value: string;
    /** Who it's from, where several providers' are listed. */
    withProvider?: string;
    onChoose(): void;
  },
): ReactNode {
  const cost = priced(model);
  return (
    <li>
      <button
        type="button"
        className="model-row model-row-model"
        disabled={!model.ready}
        aria-current={model.id === value || undefined}
        onClick={onChoose}
      >
        <span className="model-row-text">
          <b>{model.name}</b>
          <span>{[withProvider, ...abilities(model)].filter(Boolean).join(" · ")}</span>
          {cost ? <span>{cost}</span> : null}
        </span>
        {model.id === value ? <Icon name="check" size={16} /> : null}
      </button>
    </li>
  );
}

export function Results(
  { found, value, onProvider, onChoose }: {
    found?: Found;
    value: string;
    onProvider(id: string): void;
    onChoose(model: string): void;
  },
): ReactNode {
  if (!found) return <Loading />;
  if (!found.providers.length && !found.models.length) {
    return <p className="model-none">{say("nothingMatches")}</p>;
  }
  return (
    <div className="model-groups">
      {found.providers.length
        ? (
          <section>
            <h3 className="model-group">{say("providers")}</h3>
            <ul className="model-list">
              {found.providers.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  onOpen={() => onProvider(p.id)}
                />
              ))}
            </ul>
          </section>
        )
        : null}
      {found.models.length
        ? (
          <section>
            <h3 className="model-group">{say("models")}</h3>
            <ul className="model-list">
              {found.models.map((m) =>
                m.ready
                  ? (
                    <ModelRow
                      key={m.id}
                      model={m}
                      value={value}
                      withProvider={m.from}
                      onChoose={() => onChoose(m.id)}
                    />
                  )
                  : (
                    <li key={m.id}>
                      {/* One that can't run yet leads to its provider, to add the key. */}
                      <button
                        type="button"
                        className="model-row"
                        onClick={() => onProvider(m.provider)}
                      >
                        <span className="model-row-text">
                          <b>{m.name}</b>
                          <span>{m.from}</span>
                        </span>
                        <Badge>{say("needsKey")}</Badge>
                      </button>
                    </li>
                  )
              )}
            </ul>
          </section>
        )
        : null}
    </div>
  );
}

/** One provider: its key, if it takes one, and its models. */
function ProviderModels(
  { id, value, call, may, onBack, onChoose }: {
    id: string;
    value: string;
    call: Call;
    may: boolean;
    onBack(): void;
    onChoose(model: string): void;
  },
): ReactNode {
  const [shown, setShown] = useState<
    { provider: OfferedProvider | null; models: OfferedModel[] }
  >();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    call<{ provider: OfferedProvider | null; models: OfferedModel[] }>("models.offered", {
      provider: id,
    }).then(setShown, (e) => setError(message(e)));
  }, [id, call]);
  useEffect(load, [load]);
  const provider = shown?.provider;
  return (
    <div className="model-choose">
      <div className="model-provider-head">
        <IconButton icon="chevron-left" label={say("allProviders")} size="sm" onClick={onBack} />
        <h3>{provider?.name ?? id}</h3>
      </div>
      {provider?.note ? <p className="model-provider-note">{provider.note}</p> : null}
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {provider?.keyed
        ? <ProviderKey provider={provider} may={may} call={call} onChange={load} />
        : null}
      {shown
        ? (
          <ul className="model-list">
            {shown.models.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                value={value}
                onChoose={() => onChoose(m.id)}
              />
            ))}
          </ul>
        )
        : <Loading />}
    </div>
  );
}

/** The org's key for a provider: added, replaced or removed by those who run it. */
export function ProviderKey(
  { provider, may, call, onChange }: {
    provider: OfferedProvider;
    may: boolean;
    call: Call;
    onChange(): void;
  },
): ReactNode {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      setKey("");
      setEditing(false);
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!may) {
    return provider.ready ? null : (
      <Notice tone="neutral" icon="info">
        {say("noKeyForProvider", { provider: provider.name })}
      </Notice>
    );
  }
  // Asked for at once where nothing else can reach this provider.
  if (editing || (!provider.ready && !provider.hint)) {
    return (
      <form
        className="model-key"
        onSubmit={(event) => {
          event.preventDefault();
          // React hands it on to the form this picker was opened from.
          event.stopPropagation();
          if (key.trim()) {
            void act(() => call("modelKey.set", { provider: provider.id, key: key.trim() }));
          }
        }}
      >
        <label htmlFor={`key-${provider.id}`}>
          {say("apiKeyLabel", { provider: provider.name })}
        </label>
        <div className="model-key-entry">
          <Input
            id={`key-${provider.id}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={say("pasteIt")}
            value={key}
            invalid={!!error}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={busy || !key.trim()}>
            {say("save")}
          </Button>
          {provider.ready || provider.hint
            ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                {say("cancel")}
              </Button>
            )
            : null}
        </div>
        <p>
          {say("keyNote", { provider: provider.name })}
        </p>
        {error ? <p className="model-key-error" role="alert">{error}</p> : null}
      </form>
    );
  }
  return (
    <div className="model-key-kept">
      <span>
        {provider.hint
          ? say.nodes("orgKey", { hint: <code>{provider.hint}</code> })
          : say("usesAppKey")}
      </span>
      <span className="model-key-actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          {provider.hint ? say("replace") : say("useOwnKey")}
        </Button>
        {provider.hint
          ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void act(() => call("modelKey.remove", { provider: provider.id }))}
            >
              {say("remove")}
            </Button>
          )
          : null}
      </span>
      {error ? <p className="model-key-error" role="alert">{error}</p> : null}
    </div>
  );
}
