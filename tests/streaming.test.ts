import { assert, assertEquals } from "@std/assert";
import {
  type AttachmentStreamOutput,
  createCopilotz,
  isAttachmentStreamOutput,
  type RealtimeProviderResource,
} from "../index.ts";

function streamOf(chunks: readonly number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

async function readBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<number[]> {
  const result: number[] = [];
  for await (const chunk of stream) result.push(...chunk);
  return result;
}

Deno.test("one-call stream ingress preserves backpressure and persists semantics only", async () => {
  const provider: RealtimeProviderResource = {
    resourceType: "providers",
    kind: "realtime",
    id: "test.realtime",
    async *run(input) {
      const received: number[] = [];
      for await (const chunk of input.payload) received.push(...chunk);
      yield {
        kind: "stream",
        participant: { id: "voice-a", name: "Voice A", type: "agent" },
        mediaType: "audio/pcm;rate=24000",
        streamId: `${input.streamId}:a`,
        payload: streamOf([[10, 11], [12]]),
      };
      yield {
        kind: "stream",
        participant: { id: "voice-b", name: "Voice B", type: "agent" },
        mediaType: "audio/pcm;rate=24000",
        streamId: `${input.streamId}:b`,
        payload: streamOf([[20], [21, 22]]),
      };
      yield {
        kind: "event",
        event: {
          type: "transcript.finalized",
          namespace: input.namespace,
          threadId: input.threadId,
          payload: { text: "heard audio", byteCount: received.length },
          routing: {},
          visibility: { kind: "public" },
          metadata: {},
        },
      };
      yield {
        kind: "message",
        input: {
          content: "Realtime answer",
          sender: {
            id: input.agent?.id,
            type: "agent",
            name: input.agent?.name,
          },
        },
      };
    },
  };
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    providers: [provider],
    agents: [{
      id: "voice",
      name: "Voice",
      role: "realtime agent",
      runtimes: {
        realtime: { type: "realtime", provider: provider.id },
      },
    }],
  });

  try {
    const attachment = await copilotz.connect({
      thread: "audio-thread",
      participant: { externalId: "user", participantType: "human" },
    });
    const streamResults: Array<
      Promise<{
        participant: string;
        streamId: string;
        bytes: number[];
      }>
    > = [];
    const semanticTypes: string[] = [];
    const observe = (async () => {
      for await (const output of attachment.outputs) {
        if (isAttachmentStreamOutput(output)) {
          const stream = output as AttachmentStreamOutput;
          streamResults.push(
            readBytes(stream.payload).then((bytes) => ({
              participant: stream.participant.id,
              streamId: stream.streamId,
              bytes,
            })),
          );
        } else {
          semanticTypes.push(output.type);
        }
      }
    })();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pulled = false;
    const microphone = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      async pull(controller) {
        if (pulled) return;
        pulled = true;
        await gate;
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    const accepted = await Promise.race([
      attachment.send({
        type: "audio.input",
        mediaType: "audio/pcm;rate=24000",
        payload: microphone,
        target: "voice",
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("stream was not accepted promptly")),
          1_000,
        )
      ),
    ]);
    assert("streamId" in accepted);
    release();
    await accepted.done;
    const persisted = await copilotz.events.list({
      correlationId: accepted.correlationId,
    });
    await attachment.close();
    await observe;

    assertEquals(
      (await Promise.all(streamResults)).toSorted((left, right) =>
        left.participant.localeCompare(right.participant)
      ),
      [
        {
          participant: "voice-a",
          streamId: `${accepted.streamId}:a`,
          bytes: [10, 11, 12],
        },
        {
          participant: "voice-b",
          streamId: `${accepted.streamId}:b`,
          bytes: [20, 21, 22],
        },
      ],
    );
    assertEquals(persisted.map((event) => event.type), [
      "participant.created",
      "thread.participant_added",
      "stream.opened",
      "transcript.finalized",
      "message.created",
      "stream.closed",
    ]);
    assertEquals(
      persisted.some((event) => JSON.stringify(event).includes("[1,2,3]")),
      false,
    );
    assert(semanticTypes.includes("transcript.finalized"));
    assert(semanticTypes.includes("message.created"));
  } finally {
    await copilotz.shutdown();
  }
});
