/**
 * The tier beside the send button (kind `tiers.composer`, chat's
 * `composerControls`, hints `{ thread?, in? }`): what what's sent runs on,
 * with what a typical message comes to for the person, their own plans
 * costing nothing ("Everyday · on your plans · model $0"). In a
 * conversation, choosing one sets that conversation's tier
 * (`tiers.choose { thread }`), for everyone in it; on home, the person's own
 * default for new chats (`{ mine }`). Each tier says its price; one over the
 * org's cap is out of reach for those who don't run it, and says who sets
 * it. Back to the default where one was chosen.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "copilotz";
import { Menu, type MenuItem, toast } from "copilotz/web";
import { runs, useStanding } from "copilotz/plugins/interfaces/contract";
import type { Shown } from "../../contract.ts";
import { STYLE } from "./style.ts";
import { say } from "./say.ts";
import { bySaid, shownSaid, tierPriceSaid } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const tiersComposerView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const thread = typeof ctx.hints.thread === "string" ? ctx.hints.thread : undefined;
  const space = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const shown = shownSaid(
    ctx.db.collection("modelChoice").query<Shown>("offered", {
      ...(space ? { space } : {}),
      ...(thread ? { thread } : {}),
    }).value,
  );
  if (!shown?.tiers.length || !shown.now) return null;
  return (
    <>
      <style href="tiers-web" precedence="copilotz">{STYLE}</style>
      <TierPick shown={shown} thread={thread} call={ctx.call} />
    </>
  );
};

function TierPick(
  { shown, thread, call }: { shown: Shown; thread?: string; call: Call },
): ReactNode {
  const standing = useStanding(call);
  const [busy, setBusy] = useState(false);
  const free = !!standing && runs(standing);
  const now = shown.now!;
  const tier = shown.tiers.find((t) => t.name === now.tier);
  const capIndex = shown.org.cap ? shown.tiers.findIndex((t) => t.name === shown.org.cap) : -1;
  const capTitle = capIndex >= 0 ? shown.tiers[capIndex].title : undefined;
  // What's been chosen right here: the conversation's, or on home the person's own.
  const own = thread ? shown.thread?.tier : shown.person.tier;
  const choose = async (name: string | null) => {
    setBusy(true);
    try {
      await call("tiers.choose", { tier: name, ...(thread ? { thread } : { mine: true }) });
      const title = shown.tiers.find((t) => t.name === name)?.title;
      toast(
        thread
          ? title ? say("chatRunsOn", { tier: title }) : say("chatRunsDefault")
          : title
          ? say("newChatsOn", { tier: title })
          : say("newChatsDefault"),
      );
    } catch (e) {
      toast((e as Error).message, { tone: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const items: (MenuItem | "separator")[] = [
    ...shown.tiers.map((t, i): MenuItem => {
      const price = tierPriceSaid(t);
      const over = !free && capIndex >= 0 && i > capIndex;
      return {
        label: `${t.title}${price ? ` · ${price}` : ""}`,
        ...(t.name === now.tier ? { icon: "check" as const } : {}),
        ...(over ? { disabled: true } : {}),
        onSelect: () => void choose(t.name),
      };
    }),
    ...(own
      ? [
        "separator" as const,
        {
          label: thread ? say("backToDefault") : say("backToOrgDefault"),
          onSelect: () => void choose(null),
        },
      ]
      : []),
  ];
  const price = tier && tierPriceSaid(tier);
  return (
    <span className="tiers-pick" aria-busy={busy || undefined}>
      <Menu
        label={`${say("pickLabel", { tier: tier?.title ?? now.tier, by: bySaid(now.by) })}${
          capTitle && !free ? `. ${say("pickCap", { cap: capTitle })}` : ""
        }`}
        text={
          <span className="tiers-pick-text">
            <span className="tiers-pick-name">{tier?.title ?? now.tier}</span>
            {price ? <span className="tiers-pick-price">{` · ${price}`}</span> : null}
          </span>
        }
        icon="sparkles"
        variant="ghost"
        size="sm"
        side="top"
        align="end"
        items={items}
      />
    </span>
  );
}
