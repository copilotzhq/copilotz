import type { CopilotzDb } from "@/database/index.ts";
import type { ChatContext, Event, NewEvent, NewUnknownEvent, ContentStreamData, MessagePayload, User, TokenEventPayload } from "@/interfaces/index.ts";
import type { EventBase } from "@/database/schemas/index.ts";
import { startThreadEventWorker } from "@/event-processors/index.ts";
import { ulid } from "ulid";

type MaybePromise<T> = T | Promise<T>;

const USER_UPSERT_DEBOUNCE_MS = 60_000;
const userUpsertCache = new Map<string, number>();

export type RunOptions = {
    stream?: boolean;
    ackMode?: "immediate" | "onComplete";
    signal?: AbortSignal;
    queueTTL?: number;
};

export type StreamEvent = Event | (EventBase & { type: string; payload: Record<string, unknown> });

export type RunHandle = {
    queueId: string;
    threadId: string;
    status: "queued";
    events: AsyncIterable<StreamEvent>;
    done: Promise<void>;
    cancel: () => void;
};

export type UnifiedOnEvent = (event: Event) => MaybePromise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void>;

class AsyncQueue<T> implements AsyncIterable<T> {
    private buffer: T[] = [];
    private resolvers: Array<(value: IteratorResult<T>) => void> = [];
    private closed = false;
    private errorValue: unknown | null = null;

    push(item: T): void {
        if (this.closed || this.errorValue) return;
        if (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift()!;
            resolve({ value: item, done: false });
        } else {
            this.buffer.push(item);
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift()!;
            resolve({ value: undefined as unknown as T, done: true });
        }
    }

    error(err: unknown): void {
        if (this.closed) return;
        this.errorValue = err ?? new Error("AsyncQueue error");
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift()!;
            resolve({ value: undefined as unknown as T, done: true });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                if (this.errorValue) {
                    return Promise.reject(this.errorValue);
                }
                if (this.buffer.length > 0) {
                    const value = this.buffer.shift()!;
                    return Promise.resolve({ value, done: false });
                }
                if (this.closed) {
                    return Promise.resolve({ value: undefined as unknown as T, done: true });
                }
                return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
            },
        };
    }
}

function _nowIso(): string {
    return new Date().toISOString();
}

function toEventId(): string {
    return ulid();
}

function buildUserKey(sender: MessagePayload["sender"]): string {
    if (!sender) return "anonymous";
    const metadata = sender.metadata && typeof sender.metadata === "object"
        ? sender.metadata as Record<string, unknown>
        : undefined;
    const email = metadata && typeof metadata.email === "string"
        ? metadata.email
        : "";
    return sender.externalId ?? sender.id ?? email ?? sender.name ?? "anonymous";
}

export async function upserUser(ops: CopilotzDb["ops"], sender: MessagePayload["sender"]): Promise<void> {
    if (!sender || sender.type !== "user") return;
    const key = buildUserKey(sender);
    const last = userUpsertCache.get(key) ?? 0;
    if (Date.now() - last < USER_UPSERT_DEBOUNCE_MS) return;

    try {
        // Try by externalId first
        let existing = sender.externalId ? await ops.getUserByExternalId(sender.externalId).catch(() => undefined) : undefined;
        // Fallback by email if present
        const metadata = sender.metadata && typeof sender.metadata === "object"
            ? sender.metadata as Record<string, unknown>
            : undefined;
        const email = metadata && typeof metadata.email === "string"
            ? metadata.email
            : null;
        if (!existing && email) {
            const byEmail = await ops.crud.users.findOne({ email }).catch(() => null);
            existing = (byEmail as unknown as User) ?? undefined;
        }

        const desired = {
            name: sender.name ?? null,
            email,
            externalId: sender.externalId ?? null,
            metadata: metadata ?? null,
        };

        if (existing && typeof (existing as { id?: unknown }).id !== "undefined") {
            const updates: Record<string, unknown> = {};
            if (desired.name && existing.name !== desired.name) updates.name = desired.name;
            if (desired.email && existing.email !== desired.email) updates.email = desired.email;
            if (desired.externalId && existing.externalId !== desired.externalId) updates.externalId = desired.externalId;
            if (JSON.stringify(existing.metadata ?? null) !== JSON.stringify(desired.metadata ?? null)) {
                updates.metadata = desired.metadata;
            }
            if (Object.keys(updates).length > 0) {
                await ops.crud.users.update({ id: (existing as { id: string }).id }, updates);
            }
        } else {
            await ops.crud.users.create(desired);
        }
    } catch (_err) {
        // Ignore user upsert failures to avoid breaking the run flow
    } finally {
        userUpsertCache.set(key, Date.now());
    }
}

export async function runThread(
    db: CopilotzDb,
    baseContext: ChatContext,
    message: MessagePayload,
    externalOnEvent?: UnifiedOnEvent,
    options?: RunOptions,
): Promise<RunHandle> {
    const ops = db.ops;
    const stream = options?.stream ?? baseContext.stream ?? false;
    const queue = new AsyncQueue<StreamEvent>();
    const doneResolve = (() => {
        let resolve!: () => void;
        let reject!: (err: unknown) => void;
        const p = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
        return { promise: p, resolve, reject };
    })();

    let cancelled = false;
    const cancel = () => { cancelled = true; queue.close(); };
    if (options?.signal) {
        if (options.signal.aborted) cancel();
        options.signal.addEventListener("abort", cancel, { once: true });
    }

    // Resolve thread
    const sender = message.sender;
    const threadRef = message.thread ?? undefined;
    let threadId: string | undefined = (threadRef?.id ?? undefined) || undefined;
    if (!threadId && threadRef?.externalId) {
        const existingByExt = await ops.getThreadByExternalId(threadRef.externalId);
        if (existingByExt?.id) threadId = existingByExt.id as string;
    }
    // If still undefined, let the DB assign a ULID on creation

    // Participants: prefer provided; else, use existing thread participants if available; else, from configured agents
    let baseParticipants: string[] = [];
    if (Array.isArray(threadRef?.participants) && threadRef?.participants.length) {
        baseParticipants = threadRef.participants;
    } else {
        try {
            const existingThread = threadId ? await ops.getThreadById(threadId) : undefined;
            if (existingThread && Array.isArray(existingThread.participants) && existingThread.participants.length > 0) {
                baseParticipants = existingThread.participants as string[];
            } else {
                baseParticipants = (baseContext.agents ?? []).map((a) => a.name).filter(Boolean);
            }
        } catch {
            baseParticipants = (baseContext.agents ?? []).map((a) => a.name).filter(Boolean);
        }
    }
    const senderCanonical = (sender.id ?? sender.name ?? "user") as string;
    const participants = Array.from(new Set([senderCanonical, ...baseParticipants]));

    const ensuredThread = await ops.findOrCreateThread(threadId, {
        name: threadRef?.name ?? "Main Thread",
        description: threadRef?.description ?? undefined,
        participants,
        externalId: threadRef?.externalId ?? undefined,
        parentThreadId: undefined,
        metadata: threadRef?.metadata ?? undefined,
        status: "active",
        mode: "immediate",
    });
    threadId = ensuredThread.id as string;

    const normalizedSender: MessagePayload["sender"] = {
        id: message.sender?.id ?? message.sender?.externalId ?? message.sender?.name ?? undefined,
        externalId: message.sender?.externalId ?? null,
        type: message.sender?.type ?? "user",
        name: message.sender?.name ?? message.sender?.id ?? message.sender?.externalId ?? null,
        identifierType: message.sender?.identifierType ?? undefined,
        metadata: message.sender?.metadata && typeof message.sender.metadata === "object"
            ? message.sender.metadata as Record<string, unknown>
            : null,
    };

    const normalizedThread: MessagePayload["thread"] = {
        ...(message.thread ?? {}),
        externalId: message.thread?.externalId ?? threadRef?.externalId ?? undefined,
    };

    const normalizedToolCalls: MessagePayload["toolCalls"] = Array.isArray(message.toolCalls)
        ? message.toolCalls
            .filter((call): call is NonNullable<typeof call> => Boolean(call && call.name))
            .map((call) => ({
                id: call.id ?? null,
                name: call.name,
                args: (call.args && typeof call.args === "object")
                    ? call.args as Record<string, unknown>
                    : {},
            }))
        : null;

    const normalizedMetadata = message.metadata && typeof message.metadata === "object"
        ? message.metadata as Record<string, unknown>
        : message.metadata ?? null;

    const normalizedMessage: MessagePayload = {
        ...message,
        sender: normalizedSender,
        thread: normalizedThread,
        toolCalls: normalizedToolCalls,
        metadata: normalizedMetadata,
    };

    // Best-effort upsert user sender
    try {
        await upserUser(ops, normalizedSender);
    } catch (_err) {
        // swallow to not impact main flow
    }

    // Compose callbacks
    const wrappedOnEvent = async (ev: Event): Promise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void> => {
        if (cancelled) return;
        // Note: We no longer push to stream here. Stream push happens via onStreamPush
        // after processing completes, so custom processors can replace events.
        if (typeof externalOnEvent === "function" && ev.type !== "TOKEN") {
            try {
                const res = await externalOnEvent(ev);
                if (res && (res as { producedEvents?: Array<NewEvent | NewUnknownEvent> }).producedEvents) {
                    return { producedEvents: (res as { producedEvents?: Array<NewEvent | NewUnknownEvent> }).producedEvents };
                }
            } catch { /* ignore user callback errors */ }
        } else if (typeof externalOnEvent === "function" && ev.type === "TOKEN") {
            // tokens are read-only; still notify but ignore any return
            try { await externalOnEvent(ev); } catch { /* ignore */ }
        }
    };

    // Called after processing completes, only if event was not replaced by custom processor
    const onStreamPush = (ev: Event): void => {
        if (cancelled) return;
        try {
            queue.push(ev);
        } catch { /* ignore */ }
    };

    const wrappedOnContentStream = (data: ContentStreamData) => {
        if (cancelled) return;
        const tokenPayload: TokenEventPayload = {
            threadId,
            agentName: data.agentName,
            token: data.token,
            isComplete: !!data.isComplete,
        };
        const tokenEvent: Event = {
            id: toEventId(),
            threadId,
            type: "TOKEN",
            payload: tokenPayload,
            parentEventId: null,
            traceId: null,
            priority: null,
            metadata: null,
            ttlMs: null,
            expiresAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            status: data.isComplete ? "completed" : "processing",
        };
        try {
            queue.push(tokenEvent);
        } catch { /* ignore */ }
        if (typeof externalOnEvent === "function") {
            // fire-and-forget; ignore any override attempt for tokens
            Promise.resolve()
                .then(() => externalOnEvent(tokenEvent))
                .catch(() => undefined);
        }
    };

    const newQueueItem = await ops.addToQueue(threadId, {
        eventType: "NEW_MESSAGE",
        payload: normalizedMessage,
        ttlMs: options?.queueTTL,
        metadata: normalizedMetadata ?? undefined,
    });

    const contextForWorker: ChatContext = {
        ...baseContext,
        stream,
        callbacks: {
            onEvent: wrappedOnEvent,
            onContentStream: wrappedOnContentStream,
            onStreamPush,
        },
    };

    // Start and wire completion
    Promise.resolve()
        .then(async () => {
            await startThreadEventWorker(db, threadId!, contextForWorker);
        })
        .then(() => {
            queue.close();
            doneResolve.resolve();
        })
        .catch((err) => {
            queue.error(err);
            doneResolve.reject(err);
        });

    const handle: RunHandle = {
        queueId: String(newQueueItem.id),
        threadId: threadId!,
        status: "queued",
        events: queue,
        done: doneResolve.promise,
        cancel,
    };
    return handle;
}


