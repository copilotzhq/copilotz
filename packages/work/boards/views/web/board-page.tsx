/**
 * A board's page (kind `board`, at `/board/<id>`; `?card=<id>` opens a
 * card): its name (renamed in place), its space, what it's for, its menu,
 * then the board itself, filling the page and scrolling sideways. And a
 * board shown inside something else (kind `board.inline`, item `{ _id }`,
 * hints `{ in, mode }`): a space's tab with one board (`inline`), or the
 * side panel beside a chat (`panel`, compact), its name a link to its page.
 * Live: what others and agents change shows at once.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "copilotz";
import {
  Badge,
  Button,
  EmptyState,
  Menu,
  message,
  Notice,
  Page,
  Skeleton,
  Title,
} from "copilotz/web";
import type { Board } from "../../contract.ts";
import { boardPath, boardsTab } from "../../contract.ts";
import { BoardAbout, boardMenu, BoardName, DeleteBoard, NewBoard } from "./board-head.tsx";
import { BoardView } from "./board-view.tsx";
import { Glyph } from "./glyphs.tsx";
import { boardData, type Loaded, type Place, placeName, placesOf } from "./load.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const style = <style href="boards-web" precedence="copilotz">{STYLE}</style>;

export const boardPageView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const board = ctx.db.collection<Board>("board").findOne({ _id: id }).value;
  const places = placesOf(ctx);
  const data = boardData(ctx, board);
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  if (board === undefined || !places) return <Loading page />;
  if (!board) {
    return (
      <div className="board-missing">
        {style}
        <Title text="No such board" />
        <EmptyState
          icon="search"
          heading="h1"
          title="No board here"
          action={<Button variant="primary" icon="home" href="/">Go home</Button>}
        >
          It may have been deleted, or it's in a space you're not in.
        </EmptyState>
      </div>
    );
  }
  const space = typeof ctx.hints.in === "string" ? ctx.hints.in : board.in;
  return (
    <>
      {style}
      <BoardScreen
        key={board._id}
        board={board}
        data={data}
        place={places.find((p) => p._id === board.in)}
        me={ctx.viewer?.name}
        mode="page"
        space={space}
        opened={query.card}
        call={ctx.call}
      />
    </>
  );
};

export const boardInlineView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const board = ctx.db.collection<Board>("board").findOne({ _id: item._id ?? "" }).value;
  const places = placesOf(ctx);
  const data = boardData(ctx, board);
  const mode = ctx.hints.mode === "panel" ? "panel" : "inline";
  if (board === undefined || !places) return <Loading />;
  if (!board) return null;
  return (
    <>
      {style}
      <BoardScreen
        key={board._id}
        board={board}
        data={data}
        place={places.find((p) => p._id === board.in)}
        me={ctx.viewer?.name}
        mode={mode}
        space={typeof ctx.hints.in === "string" ? ctx.hints.in : board.in}
        call={ctx.call}
      />
    </>
  );
};

/** While a board loads: its shape, quietly. */
function Loading({ page }: { page?: boolean }): ReactNode {
  const columns = (
    <div className="board-loading-columns" aria-busy="true">
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={page ? 420 : 260} radius="xl" />)}
    </div>
  );
  if (!page) return <div className="board-loading">{style}{columns}</div>;
  return (
    <Page title={<Skeleton width={240} height={30} />} width="full" className="board-page">
      {style}
      <div className="board-loading">
        <Skeleton height={34} width={420} />
        {columns}
      </div>
    </Page>
  );
}

function BoardScreen(
  { board, data, place, me, mode, space, opened, call }: {
    board: Board;
    data: Loaded;
    place?: Place;
    me?: string;
    mode: "page" | "inline" | "panel";
    space: string;
    opened?: string;
    call: Call;
  },
): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string>();
  const can = !!place?.can?.includes("write") && !place.archived;
  const where = placeName(place);
  const menu = boardMenu({
    board,
    can,
    ...(mode === "page" ? {} : { inline: { space } }),
    onRename: () => setRenaming(true),
    onDescribe: () => setDescribing(true),
    onAddColumn: () => setAddingColumn(true),
    onDelete: () => setDeleting(true),
    ...(mode === "page" ? {} : { onNewBoard: () => setMaking(true) }),
    call: <R,>(action: string, input?: unknown) =>
      call<R>(action, input).catch((e): never => {
        setError(message(e));
        throw e;
      }),
  });
  const archived = board.archived
    ? (
      <Notice
        tone="neutral"
        icon="archive"
        title="This board is archived"
        action={can
          ? (
            <Button
              size="sm"
              icon="restore"
              onClick={() =>
                void call("board.update", { board: board._id, archived: false }).catch((e) =>
                  setError(message(e))
                )}
            >
              Restore
            </Button>
          )
          : undefined}
      >
        It's kept apart from the space's boards in use; its cards still change.
      </Notice>
    )
    : null;
  const failed = error ? <Notice tone="destructive" role="alert">{error}</Notice> : null;
  const board$ = data.cards && data.people
    ? (
      <BoardView
        board={board}
        cards={data.cards}
        people={data.people}
        team={data.team}
        names={data.names}
        me={me}
        can={can}
        mode={mode}
        space={space}
        call={call}
        opened={opened}
        addingColumn={addingColumn}
        onAddingColumn={setAddingColumn}
        head={mode === "page" ? undefined : (
          <div className="board-head">
            <div className="board-head-row">
              <h2 className="board-head-title">
                <Glyph name="board" size={18} />
                {renaming
                  ? (
                    <BoardName
                      board={board}
                      can={can}
                      renaming
                      onRenaming={setRenaming}
                      call={call}
                    />
                  )
                  : <a href={boardPath(board._id, space)}>{board.name}</a>}
                {board.archived ? <Badge>Archived</Badge> : null}
              </h2>
              <div className="board-head-actions">
                <Menu label={`${board.name}: more`} align="end" size="sm" items={menu} />
              </div>
            </div>
            {mode === "inline" || describing
              ? (
                <BoardAbout
                  board={board}
                  can={can}
                  writing={describing}
                  onWriting={setDescribing}
                  call={call}
                />
              )
              : null}
            {archived}
            {failed}
          </div>
        )}
      />
    )
    : (
      <div className="board-loading-columns" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={mode === "page" ? 420 : 240} radius="xl" />
        ))}
      </div>
    );
  const extras = (
    <>
      {deleting
        ? (
          <DeleteBoard
            board={board}
            cards={data.cards?.length ?? 0}
            onClose={() => setDeleting(false)}
            call={call}
            after={mode === "page" ? boardsTab(board.in) : undefined}
          />
        )
        : null}
      {making
        ? <NewBoard space={board.in} where={where} onClose={() => setMaking(false)} call={call} />
        : null}
    </>
  );
  if (mode !== "page") {
    return (
      <>
        {board$}
        {extras}
      </>
    );
  }
  return (
    <Page
      title={
        <BoardName
          board={board}
          can={can}
          renaming={renaming}
          onRenaming={setRenaming}
          call={call}
        />
      }
      leading={
        <span className="copilotz-page-icon">
          <Glyph name="board" size={20} />
        </span>
      }
      back={{ href: boardsTab(board.in), label: `${where} · Board` }}
      badges={board.archived ? <Badge>Archived</Badge> : null}
      description={
        <BoardAbout
          board={board}
          can={can}
          writing={describing}
          onWriting={setDescribing}
          call={call}
        />
      }
      actions={menu.length ? <Menu label={`${board.name}: more`} align="end" items={menu} /> : null}
      width="full"
      className="board-page"
    >
      <Title text={board.name} />
      {archived}
      {failed}
      {board$}
      {extras}
    </Page>
  );
}
