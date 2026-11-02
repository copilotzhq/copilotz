/**
 * Making a cloud computer in a space (kind `cloud.new`, the computers'
 * "Add a computer" dialog's choice: `computerKinds`' `add`; item `{ _id }`,
 * the space; `hints.where`, its name): the sizes as cards (vCPU, memory,
 * shared or dedicated CPU, and what an hour awake costs, as people pay),
 * once what that means (you pay while it's awake; it sleeps after a while
 * unused; its disk is kept, at its price a GB-month), a name, then
 * `cloud.create`. Made, it says so, with a way to open it (which wakes it).
 * Refused (guests don't make them, or the org is out of credits or at its
 * month's budget), it says so plainly, and who can help.
 */
import { type ReactNode, useId, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Field,
  Icon,
  Input,
  message,
  Notice,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import {
  COLLECTION,
  money,
  refusalOf,
  type Sizes,
  sizesOf,
  specsOf,
  suggestedName,
} from "./cloud.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Minutes as a sentence says them: "10 minutes", "1 minute", "2 hours". */
export const minutes = (n: number): string =>
  n % 60 === 0 && n >= 60
    ? `${n / 60} hour${n === 60 ? "" : "s"}`
    : `${n} minute${n === 1 ? "" : "s"}`;

export const cloudNewView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const where = typeof ctx.hints.where === "string" ? ctx.hints.where : undefined;
  const offered = ctx.db.collection(COLLECTION).query<unknown>("sizes", {}).value;
  const style = <style href="cloud-web" precedence="copilotz">{STYLE}</style>;
  if (offered === undefined) {
    return (
      <div className="cloud-new" aria-busy="true">
        {style}
        <div className="cloud-sizes-list">
          <Skeleton height={132} radius="xl" />
          <Skeleton height={132} radius="xl" />
        </div>
        <Skeleton height={40} radius="lg" />
      </div>
    );
  }
  return (
    <>
      {style}
      <NewCloud space={space} where={where} sizes={sizesOf(offered)} call={ctx.call} />
    </>
  );
};

const REFUSED = {
  forbidden: {
    title: "Guests don't make cloud computers here",
    text: (where: string) => `Ask someone in the org to make one for ${where}.`,
  },
  credits: {
    title: "This org is out of credits",
    text: () => "Its owners and admins can add more in Billing. Nothing you have is affected.",
  },
  budget: {
    title: "This org has reached its budget for the month",
    text: () => "Its owners and admins can raise it in Billing. Nothing you have is affected.",
  },
};

export function NewCloud(
  { space, where, sizes, call }: { space: string; where?: string; sizes: Sizes; call: Call },
): ReactNode {
  const id = useId();
  const [size, setSize] = useState(sizes.sizes[0]?.id ?? "");
  const [name, setName] = useState(() => suggestedName(where));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Refused before asking, when the app says so (guests don't, or the org can't spend).
  const [refused, setRefused] = useState<keyof typeof REFUSED | undefined>(() =>
    sizes.create
      ? undefined
      : sizes.why === "budget" || sizes.why === "credits"
      ? sizes.why
      : "forbidden"
  );
  const [made, setMade] = useState<{ computer: string; name: string }>();
  const chosen = sizes.sizes.find((s) => s.id === size) ?? sizes.sizes[0];
  const here = where && where !== "Personal" ? where : "your Personal space";

  if (!chosen) {
    return (
      <Notice tone="neutral" icon="server" title="No cloud computers to make here">
        This app doesn't offer any sizes of cloud computer yet.
      </Notice>
    );
  }
  if (made) {
    const href = `/computer/${encodeURIComponent(made.computer)}${
      space ? `?in=${encodeURIComponent(space)}` : ""
    }`;
    return (
      <div className="cloud-made" role="status">
        <span className="cloud-made-icon">
          <Icon name="check" size={22} />
        </span>
        <div className="cloud-made-text">
          <p className="cloud-made-name">{made.name} is ready</p>
          <p>
            It's in{" "}
            {here}, and agents there can use it now. It wakes the first time it's used, in a few
            seconds, and sleeps again after {minutes(sizes.warmMinutes)} unused.
          </p>
          <Button variant="primary" icon="terminal" href={href}>Open {made.name}</Button>
        </div>
      </div>
    );
  }

  const disk = sizes.disk;
  return (
    <form
      className="cloud-new"
      aria-label="New cloud computer"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || refused) return;
        setBusy(true);
        setError(undefined);
        const named = name.trim() || suggestedName(where);
        try {
          const answer = await call<{ computer: string | { _id: string } }>("cloud.create", {
            size: chosen.id,
            ...(space ? { in: space } : {}),
            name: named,
          });
          const computer = typeof answer.computer === "string"
            ? answer.computer
            : answer.computer._id;
          setMade({ computer, name: named });
        } catch (e) {
          const why = refusalOf(e);
          if (why) setRefused(why);
          else setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {refused
        ? (
          <Notice
            tone="warning"
            icon="lock"
            title={REFUSED[refused].title}
            action={refused === "forbidden"
              ? undefined
              : <Button href="/org?tab=billing" size="sm">Go to Billing</Button>}
          >
            {REFUSED[refused].text(here)}
          </Notice>
        )
        : null}
      <fieldset className="cloud-sizes" disabled={busy || !!refused}>
        <legend className="cloud-legend">Size</legend>
        <div className="cloud-sizes-list">
          {sizes.sizes.map((s) => (
            <label key={s.id} className="cloud-size" data-checked={s.id === chosen.id || undefined}>
              <input
                type="radio"
                name={`${id}-size`}
                value={s.id}
                checked={s.id === chosen.id}
                onChange={() =>
                  setSize(s.id)}
                className="cloud-size-input"
              />
              <span className="cloud-size-head">
                <span className="cloud-size-label">{s.label}</span>
                <span className="cloud-size-check" aria-hidden="true">
                  <Icon name="check" size={12} />
                </span>
              </span>
              <span className="cloud-size-specs">{specsOf(s)} memory</span>
              <span className="cloud-size-cpu">
                {s.shared ? "Shared CPU, bursts when busy" : "Dedicated CPU, steady for builds"}
              </span>
              {s.hour !== null
                ? (
                  <span className="cloud-size-price">
                    <b>{money(s.hour)}</b> per active hour
                  </span>
                )
                : null}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="cloud-new-how">
        <Icon name="info" size={15} />
        <span>
          You pay while it's awake; it sleeps after {minutes(sizes.warmMinutes)} unused. Its{" "}
          {disk.gb} GB disk is kept while it sleeps
          {disk.gbMonth !== null ? <>, at {money(disk.gbMonth)} per GB-month</> : null}.
        </span>
      </p>
      <Field label="Name" hint="You can rename it later." className="cloud-new-name">
        {(control) => (
          <Input
            {...control}
            value={name}
            maxLength={100}
            autoComplete="off"
            disabled={busy || !!refused}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      <div className="cloud-new-go">
        <span className="cloud-new-summary">
          {chosen.label} · {specsOf(chosen)}
          {chosen.hour !== null ? ` · ${money(chosen.hour)} per active hour` : ""}
        </span>
        <Button
          type="submit"
          variant="primary"
          icon="plus"
          loading={busy}
          disabled={!!refused}
        >
          Create computer
        </Button>
      </div>
    </form>
  );
}
