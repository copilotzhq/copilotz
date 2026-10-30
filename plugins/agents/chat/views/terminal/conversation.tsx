/**
 * A conversation on a terminal (kind `thread`): what was said, in the
 * scrollback (subthreads' messages beside the thread's own), then what
 * agents are writing right now, and who's working. Each message and each
 * reply being written is a part: a token re-runs its reply's line alone.
 */
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Scrollback } from "../../../../../hosts/terminal/mod.ts";
import type { Live } from "../../collections/live.ts";
import type { Message } from "../../collections/message.ts";

export const conversationView = (t: { _id: string }, ctx: ViewContext<ReactNode>) => {
  const said = ctx.db.collection<Message>("message").query<Message[]>("conversation", {
    thread: t._id,
  });
  const subthreads = (said.value ?? []).flatMap((m) => m.subthread ? [m.subthread] : []);
  const live = ctx.db.collection<Live>("live").find({ thread: { $in: [t._id, ...subthreads] } }, {
    sort: { at: 1 },
  });
  const working = [...new Set((live.value ?? []).map((l) => l.agent))];
  return (
    <>
      <Scrollback
        entries={(said.value ?? []).map((m) => ({
          key: m._id,
          node: ctx.show("message", m, { thread: t._id }),
        }))}
      />
      {(live.value ?? []).map((l) => ctx.show("live", l, { thread: t._id }))}
      {working.length ? <Spinner label={`${working.join(", ")} working…`} /> : <Text></Text>}
    </>
  );
};
