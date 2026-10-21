/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { readSenders, SenderAvatar } from "@copilotz/copilotz/core/web";
import type { ChatSender } from "@copilotz/copilotz/core/web";
import {
  Badge,
  Button,
  cn,
  ConfirmDialog,
  FormDialog,
  Input,
  ReadStatus,
  ResourceList,
  ResourceRow,
  ResourceToolbar,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@copilotz/copilotz/web/kit";

type Member = ChatSender & { owner: boolean; email?: string };

function Members(
  { members, panel, onAdd, onRemove }: {
    members: readonly Member[];
    panel: boolean;
    onAdd?(email: string): Promise<unknown>;
    onRemove?(member: Member): Promise<unknown>;
  },
): React.ReactElement {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const needle = query.trim().toLowerCase();
  const visible = members.filter((member) =>
    `${member.name} ${member.email ?? ""}`.toLowerCase().includes(needle)
  );
  return (
    <div
      className={cn(
        "mx-auto grid w-full gap-3",
        panel ? "p-3" : "max-w-3xl p-4 sm:p-6",
      )}
    >
      <ResourceToolbar
        search={query}
        onSearch={setQuery}
        searchLabel="Search members"
      >
        {onAdd && (
          <Button
            type="button"
            size="sm"
            onClick={() => setAdding(true)}
          >
            <UserPlus /> Add
          </Button>
        )}
      </ResourceToolbar>
      <ResourceList label="Members">
        {visible.map((member) => (
          <ResourceRow
            key={member.id}
            leading={<SenderAvatar sender={member} size="sm" />}
            title={member.name}
            subtitle={member.email}
            meta={member.owner
              ? <Badge variant="secondary">Owner</Badge>
              : member.type === "agent"
              ? <Badge variant="outline">Agent</Badge>
              : undefined}
            actions={onRemove && !member.owner
              ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${member.name}`}
                      onClick={() => setRemoving(member)}
                    >
                      <UserMinus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              )
              : undefined}
          />
        ))}
      </ResourceList>
      {!visible.length && (
        <p className="text-muted-foreground py-6 text-center text-sm">
          {needle ? `No members match “${query.trim()}”.` : "No members yet."}
        </p>
      )}
      {onAdd && (
        <FormDialog
          open={adding}
          onOpenChange={(open) => {
            setAdding(open);
            if (!open) setEmail("");
          }}
          title="Add a member"
          description="They can see this Space and its conversations."
          submitLabel="Add member"
          canSubmit={/^\S+@\S+\.\S+$/.test(email.trim())}
          onSubmit={() => onAdd(email.trim())}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Email
            <Input
              type="email"
              autoFocus
              value={email}
              placeholder="name@example.com"
              onChange={(event) =>
                setEmail((event.target as unknown as { value: string }).value)}
            />
          </label>
        </FormDialog>
      )}
      {onRemove && (
        <ConfirmDialog
          open={Boolean(removing)}
          onOpenChange={(open) => !open && setRemoving(null)}
          title={`Remove ${removing?.name ?? "this member"}?`}
          description="They lose access to this Space and its conversations."
          confirmLabel="Remove"
          destructive
          onConfirm={async () => {
            if (removing) await onRemove(removing);
            return true;
          }}
        />
      )}
    </div>
  );
}

/** The people (and agents) in a Space. */
const view: ViewDefinition<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
>({
  id: "ui.spaceMembers",
  shows: "spaceMembers",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render({ spaceId }, ctx) {
    const space = ctx.collections.space.get(spaceId);
    if (!space.value) {
      return (
        <div className="p-4">
          <ReadStatus state={space} noun="Space" />
        </div>
      );
    }
    const owner = String(space.value.ownerId ?? "");
    const ids = [
      owner,
      ...(Array.isArray(space.value.memberIds)
        ? space.value.memberIds.map(String)
        : []),
    ].filter(Boolean);
    const senders = readSenders(ctx, ids);
    const members: Member[] = [...senders.values()].map((sender) => {
      const row = ctx.collections.participant.get(sender.id).value;
      return {
        ...sender,
        owner: sender.id === owner,
        ...(typeof row?.email === "string" ? { email: row.email } : {}),
      };
    });
    return (
      <Members
        members={members}
        panel={ctx.hints.mode === "panel"}
        onAdd={ctx.actions.chatAddMember
          ? (email) => ctx.actions.chatAddMember({ spaceId, email }).result()
          : undefined}
        onRemove={ctx.actions.chatRemoveMember
          ? (member) =>
            ctx.actions.chatRemoveMember({
              spaceId,
              participantId: member.id,
            }).result()
          : undefined}
      />
    );
  },
});

export default view;
