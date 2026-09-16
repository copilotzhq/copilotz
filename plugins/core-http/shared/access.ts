import type { ActionContext } from "@copilotz/copilotz/actions";
export function actor(context: ActionContext) {
  const value = context.action.metadata.httpActor as {
    id?: string;
    externalId?: string;
    name?: string;
  } | undefined;
  if (!value?.id) {
    throw new Error("Conversation mutations require an authenticated actor.");
  }
  return {
    ...value,
    id: value.id,
    externalId: value.externalId ?? value.id,
    participantType: "human" as const,
  };
}
export async function ownedThread(context: ActionContext, id: string) {
  const sender = actor(context);
  const thread = await context.collections.thread.get({ id });
  if (
    !thread || !Array.isArray(thread.participantIds) ||
    (!thread.participantIds.includes(sender.id) &&
      (context.action.metadata.coreConversationAccess as {
          threadId?: string;
        })
          ?.threadId !== id)
  ) {
    throw new Error("Thread was not found.");
  }
  return thread;
}
