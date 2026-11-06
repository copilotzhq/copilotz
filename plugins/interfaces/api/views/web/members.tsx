/**
 * A space's developer keys, among its members (kind `api.members`: spaces'
 * `spaceMembers`, item `{ _id }`, the space; hints `{ in, manage, mode }`):
 * each key that works here, whose it is, how it works here (its role, from
 * what it may use), what it may use, and when it was last used. Its person,
 * and the space's managers, revoke it, after asking. Nothing when there are
 * none; the person makes theirs in the space's API tab.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Badge, Button, Card, Icon, IconButton, Time } from "../../../../../hosts/web/mod.ts";
import { nameOf, namesIn } from "../../../../access/spaces/contract.ts";
import type { ApiKey } from "../../contract.ts";
import { presetsOf, Revoke, roleSaid } from "./keys.tsx";
import { summary } from "./snippet.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const memberKeysView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? String(ctx.hints.in ?? "");
  const keys = ctx.db.collection<ApiKey>("api_key").find({ in: id }, { sort: { at: -1 } }).value;
  if (!keys?.length) return null;
  const names = namesIn(ctx, keys.map((k) => k.person));
  return (
    <>
      <style href="api-web" precedence="copilotz">{STYLE}</style>
      <MemberKeys
        space={id}
        keys={keys}
        me={ctx.viewer?.name}
        manage={ctx.hints.manage === true}
        names={names}
        presets={Object.fromEntries(presetsOf(ctx.resources.apiPresets))}
        call={ctx.call}
      />
    </>
  );
};

function MemberKeys(
  { space, keys, me, manage, names, presets, call }: {
    space: string;
    keys: ApiKey[];
    me?: string;
    manage: boolean;
    names: Record<string, string>;
    presets: Parameters<typeof summary>[1];
    call: Call;
  },
): ReactNode {
  const [revoking, setRevoking] = useState<ApiKey>();
  const whose = (key: ApiKey) => key.person === me ? undefined : nameOf(key.person, names);
  return (
    <section className="api-members" aria-labelledby="api-members-title">
      <div className="api-members-head">
        <h3 id="api-members-title" className="api-members-title">
          Developer keys <span className="api-members-count">{keys.length}</span>
        </h3>
        <Button
          size="sm"
          variant="ghost"
          iconEnd="chevron"
          href={`/space/${encodeURIComponent(space)}?tab=api`}
        >
          Your keys
        </Button>
      </div>
      <ul className="api-members-rows">
        {keys.map((key) => {
          const theirs = whose(key);
          return (
            <Card as="li" padding="none" className="api-member" key={key._id}>
              <span className="api-member-mark" aria-hidden="true">
                <Icon name="lock" size={15} />
              </span>
              <div className="api-member-text">
                <p className="api-member-name">
                  <span>{key.name}</span>
                  {theirs ? null : <Badge tone="primary">Yours</Badge>}
                </p>
                <p className="api-member-what">
                  {theirs ? `${theirs}'s` : "Your key"}
                  <span aria-hidden="true">·</span>
                  {summary(key.scope ?? {}, presets)}
                  <span aria-hidden="true">·</span>
                  {key.used
                    ? (
                      <span>
                        Used <Time at={key.used} />
                      </span>
                    )
                    : <span>Never used</span>}
                </p>
              </div>
              <div className="api-member-end">
                <Badge variant="outline">{roleSaid(key.role)}</Badge>
                {manage || !theirs
                  ? (
                    <IconButton
                      icon="trash"
                      size="sm"
                      label={`Revoke ${key.name}`}
                      onClick={() => setRevoking(key)}
                    />
                  )
                  : null}
              </div>
            </Card>
          );
        })}
      </ul>
      <Revoke
        apiKey={revoking}
        theirs={revoking ? whose(revoking) : undefined}
        onClose={() => setRevoking(undefined)}
        call={call}
      />
    </section>
  );
}
