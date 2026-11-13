/**
 * A chat's staff notes, in the lane beside it (kind `chat.notes`, item the
 * chat `{ _id }`): what its team said there with its agents, what agents
 * are writing, and where you type ("Ask an agent or leave a note for your
 * team…", `@` listing the space's agents), as any conversation shows them
 * (`talk`); each message with words can go on to the chat as the person's
 * own ("Send to Ana…"). Before the notes are made, a word on what they're
 * for; the first message makes them (`chat.notes`), then goes there
 * (`chat.send`), and what's typed stays put while they appear. The lane
 * shows it only while it's open, so nothing is read while it's closed.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { Thread } from "../../collections/thread.ts";
import { notesOf } from "../../shared/notes.ts";
import { outsideIn, talk } from "./conversation.tsx";
import { takeOpened } from "./lane.ts";
import { NotesEmpty, NotesLoading, OnlyTeam } from "./notes-lane.tsx";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

export const notesView = (chat: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  if (!chat._id) return null;
  const about = chat._id;
  const id = notesOf(about);
  const threads = ctx.db.collection<Thread>("thread");
  // Undefined while they're read; null for notes not made yet, or a chat not theirs to see.
  const notes = threads.findOne({ _id: id }).value;
  const parent = threads.findOne({ _id: about }).value;
  const outside = outsideIn(ctx, about);
  if (notes === undefined || parent === undefined) return <NotesLoading />;
  if (!parent) return null;
  const { main } = talk(ctx, {
    id,
    thread: notes,
    ...(parent.in ? { in: parent.in } : {}),
    placeholder: say("notesPlaceholder"),
    ...(outside ? { sendTo: outside } : {}),
    note: <OnlyTeam />,
    empty: <NotesEmpty name={outside?.name ?? say("yourContact")} />,
    // Beside the chat, it takes the keys only when someone just opened it.
    autoFocus: takeOpened,
    // Made by the first message (or file) sent: the same notes however many ask at once.
    made: async () =>
      notes ? id : (await ctx.call<{ thread: string }>("chat.notes", { thread: about })).thread,
  });
  return (
    <div className="notes-talk">
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      {main}
    </div>
  );
};
