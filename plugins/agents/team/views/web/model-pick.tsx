/**
 * A model to choose, for another front end's page (kind `model.pick`): the
 * same picker an agent's model is chosen with. Item `{ value }`, the model
 * chosen now (`"provider/model"`; none: nothing yet); hints `{ action, input,
 * look?, label?, disabled? }`: choosing one calls `action` with `input` and
 * the `model` chosen, and says so if that fails. What changes shows where it's
 * read (a watched read), so it hands nothing back. `look`: the picker's field
 * (the default), or a small button saying `label` ("Change").
 *
 * ```tsx
 * <LazyView kind="model.pick" item={{ value }} hints={{ action: "tiers.pick", input: { agent } }} />
 * ```
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { message } from "../../../../../hosts/web/mod.ts";
import { ModelPicker } from "./model-picker.tsx";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export type ModelPick = {
  action: string;
  input?: Record<string, unknown>;
  look?: "field" | "link";
  label?: string;
  disabled?: boolean;
};

export const modelPickView = (
  item: { value?: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => (
  <>
    <style href="team-web" precedence="copilotz">{STYLE}</style>
    <Pick value={item.value ?? ""} pick={ctx.hints as ModelPick} call={ctx.call} />
  </>
);

function Pick({ value, pick, call }: { value: string; pick: ModelPick; call: Call }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choose = async (model: string) => {
    if (model === value) return;
    setBusy(true);
    setError(undefined);
    try {
      await call(pick.action, { ...pick.input, model });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="model-pick" data-look={pick.look ?? "field"} aria-busy={busy || undefined}>
      <ModelPicker
        value={value}
        call={call}
        look={pick.look}
        label={pick.label}
        disabled={busy || pick.disabled}
        onChange={(model) =>
          void choose(model)}
      />
      {error ? <span className="model-pick-error" role="alert">{error}</span> : null}
    </span>
  );
}
