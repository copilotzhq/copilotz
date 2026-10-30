/**
 * A space's WhatsApp (kind `whatsapp.space`: its WhatsApp tab, item
 * `{ _id }`, the space; spaces' `spaceTabs`): the number connected to it,
 * what Meta knows it as and whether its answers can go out; then your phone
 * (linking it, or, linked, where your messages go). Those who manage the
 * space connect a number (by hand, with what Meta's dashboard gives), see
 * its webhook again, replace its token and disconnect it. With none, it
 * says what it's for, and who can connect one. In a side panel
 * (`hints.mode: "panel"`), the same, compact.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Menu,
  Notice,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../../../access/spaces/contract.ts";
import type { WhatsAppCode, WhatsAppNumber, WhatsAppPhone } from "../../contract.ts";
import { ConnectDialog, DisconnectDialog, ReplaceDialog, WebhookDialog } from "./connect.tsx";
import { type Place, YourPhone } from "./phone.tsx";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const whatsappView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const numbers = ctx.db.collection<WhatsAppNumber>("whatsapp_number")
    .find({ in: id }, { sort: { at: 1 } }).value;
  // The person's own phones and codes (the rules keep them to theirs): live, so linking shows at once.
  const phones = ctx.db.collection<WhatsAppPhone>("whatsapp_phone").find({}).value;
  const codes = ctx.db.collection<WhatsAppCode>("whatsapp_code").find({}).value;
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const compact = ctx.hints.mode === "panel";
  const style = <style href="whatsapp-web" precedence="copilotz">{STYLE}</style>;
  if (!numbers || !phones || !codes || !spaces) {
    return (
      <div className="wa-tab" aria-busy="true">
        {style}
        <Skeleton height={compact ? 160 : 210} radius="xl" />
      </div>
    );
  }
  const space = spaces.find((s) => s._id === id);
  if (!space) return null;
  const personal = spaces.find((s) => s.kind === "personal");
  // Where their messages may go: Personal first, then the shared spaces they may write in.
  const places: Place[] = [
    ...(personal ? [{ _id: personal._id, name: "Personal" }] : []),
    ...spaces
      .filter((s) => s.kind !== "personal" && !s.archived && s.can.includes("write"))
      .map((s) => ({ _id: s._id, name: s.name })),
  ];
  return (
    <>
      {style}
      <WhatsApp
        key={space._id}
        space={space}
        numbers={numbers}
        phones={phones}
        codes={codes}
        places={places}
        personal={personal?._id}
        compact={compact}
        call={ctx.call}
      />
    </>
  );
};

function WhatsApp(
  { space, numbers, phones, codes, places, personal, compact, call }: {
    space: Reached;
    numbers: WhatsAppNumber[];
    phones: WhatsAppPhone[];
    codes: WhatsAppCode[];
    places: Place[];
    personal?: string;
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [connecting, setConnecting] = useState(false);
  const [hooked, setHooked] = useState<WhatsAppNumber>();
  const [replacing, setReplacing] = useState<WhatsAppNumber>();
  const [leaving, setLeaving] = useState<WhatsAppNumber>();
  const manage = space.can.includes("manage");
  const where = space.kind === "personal" ? "your Personal space" : space.name;
  const connect = (
    <ConnectDialog
      open={connecting}
      onClose={() => setConnecting(false)}
      space={space._id}
      where={space.kind === "personal" ? "Personal" : space.name}
      call={call}
    />
  );
  const empty = (
    <EmptyState
      icon="chat"
      tone="primary"
      heading="h3"
      title="Talk to your agents on WhatsApp"
      action={manage
        ? (
          <Button variant="primary" icon="plus" onClick={() => setConnecting(true)}>
            Connect a number
          </Button>
        )
        : undefined}
    >
      {manage
        ? `Connect a WhatsApp Business number, and everyone in ${where} can message their ` +
          "agents from their phone: text, photos, documents and voice notes."
        : `Those who manage ${where} can connect a WhatsApp Business number, so you can ` +
          "message your agents from your phone."}
    </EmptyState>
  );
  // The dialogs keep their place whatever shows above them: connecting the first number
  // goes on to its webhook in the same dialog.
  return (
    <div className={`wa-tab${compact ? " wa-tab-compact" : ""}`}>
      {numbers.length
        ? numbers.map((number) => (
          <Card as="section" padding="none" className="wa-number" key={number._id}>
            <header className="wa-number-head">
              <span className="wa-mark" aria-hidden="true">
                <Icon name="chat" size={20} />
              </span>
              <div className="wa-number-text">
                <h3 className="wa-number-phone">
                  {number.phone}
                  {number.problem
                    ? <Badge tone="warning">Needs attention</Badge>
                    : <Badge tone="success">Connected</Badge>}
                </h3>
                <p className="wa-number-meta">
                  {number.name ? <span>{number.name}</span> : null}
                  {number.name ? <span aria-hidden="true">·</span> : null}
                  <span>
                    WhatsApp, for everyone in {space.kind === "personal" ? "Personal" : space.name}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    connected <Time at={number.at} />
                  </span>
                </p>
              </div>
              {manage
                ? (
                  <Menu
                    label={`${number.phone}: settings`}
                    align="end"
                    items={[
                      {
                        label: "Webhook",
                        icon: "globe",
                        onSelect: () => setHooked(number),
                      },
                      {
                        label: "Replace its token",
                        icon: "refresh",
                        onSelect: () =>
                          setReplacing(number),
                      },
                      "separator",
                      {
                        label: "Disconnect",
                        icon: "trash",
                        tone: "destructive",
                        onSelect: () =>
                          setLeaving(number),
                      },
                    ]}
                  />
                )
                : null}
            </header>
            {number.problem
              ? (
                <Notice
                  className="wa-problem"
                  tone="warning"
                  title="Agents' answers can't go out"
                  action={manage
                    ? (
                      <Button
                        size="sm"
                        onClick={() => setReplacing(number)}
                      >
                        Replace its token
                      </Button>
                    )
                    : undefined}
                >
                  {manage ? number.problem : "Those who manage this space have been told."}
                </Notice>
              )
              : null}
            <div className="wa-you">
              <h4 className="wa-you-title">Your phone</h4>
              <YourPhone
                number={number}
                phone={phones.find((p) =>
                  p.number === number._id
                )}
                code={codes.find((c) => c.number === number._id)}
                places={places}
                personal={personal}
                call={call}
              />
            </div>
          </Card>
        ))
        : empty}
      {manage && !compact && numbers.length
        ? (
          <div>
            <Button variant="ghost" icon="plus" onClick={() => setConnecting(true)}>
              Connect another number
            </Button>
          </div>
        )
        : null}
      {connect}
      <WebhookDialog number={hooked} onClose={() => setHooked(undefined)} call={call} />
      <ReplaceDialog number={replacing} onClose={() => setReplacing(undefined)} call={call} />
      <DisconnectDialog number={leaving} onClose={() => setLeaving(undefined)} call={call} />
    </div>
  );
}
