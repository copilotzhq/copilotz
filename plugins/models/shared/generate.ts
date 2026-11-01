/** Calling a model: the model choice resolved, fallbacks, state, and its use told. */
import type { Actor, Context, ReadContext } from "../../../runtime/mod.ts";
import { invalid } from "../../../runtime/mod.ts";
import {
  adapterFor,
  type Media,
  type ModelRef,
  type Provider,
  resolve,
  type Resolved,
} from "./choice.ts";
import { filesFor } from "./files.ts";
import { calledBy } from "./provider.ts";
import { backoff, quietly, RETRY, SILENCE, transient, wait } from "./retry.ts";
import { used } from "./use.ts";
import { measure } from "./telemetry.ts";
import {
  EFFORTS,
  type LlmAdapter,
  type LlmChunk,
  type LlmMessage,
  type LlmSettings,
  type LlmState,
  type LlmTool,
  type ToolCall,
  type Usage,
} from "./types.ts";

/**
 * What a call needs: providers, adapters, cancellation, who it's for (a
 * provider's `headers` hear it), and (to meter it) where to record.
 */
type Reach = Pick<Context, "resources" | "adapters" | "signal"> & {
  actor?: Actor;
  call?: ReadContext["call"];
  record?: Context["record"];
  metrics?: Context["metrics"];
};

export type Generate = {
  /** `"provider/model"`, an alias, settings around one (`{ model, effort }`), or a list tried in order. */
  model: ModelRef;
  instructions?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  /** What the call is for (thread, agent, purpose…): its usage record's tags. */
  tags?: Record<string, string>;
};

export type Completion = {
  text: string;
  toolCalls: ToolCall[];
  /** What the call used, and which model answered. */
  usage?: Usage & { model?: string };
  state?: LlmState;
};

/** Throws when a model can't take its settings: an effort it has no level for. */
function checkSettings(m: Resolved) {
  const { effort } = m.settings as LlmSettings;
  if (effort === undefined) return;
  if (!EFFORTS.includes(effort)) {
    throw invalid(`"${m.id}": effort "${effort}" isn't one of ${EFFORTS.join(", ")}`);
  }
  const reasoning = m.info?.reasoning;
  if (reasoning === undefined) return; // Not in the catalog: the provider decides.
  if (reasoning === false) {
    if (effort === "none") return;
    throw invalid(`"${m.id}" doesn't reason: it takes no effort`);
  }
  if (reasoning.effort) {
    const levels = [...(reasoning.toggle ? ["none"] : []), ...reasoning.effort];
    if (levels.includes(effort)) return;
    throw invalid(`"${m.id}" takes effort ${levels.join(", ")}; not "${effort}"`);
  }
  if (reasoning.budget || reasoning.toggle) return;
  throw invalid(`"${m.id}" reasons on its own: it takes no effort`);
}

/** The models a choice names, in order, each checked: its provider, adapter and settings. */
export function chooseModels(
  ctx: Pick<Context, "resources" | "adapters">,
  model: ModelRef,
): Resolved[] {
  const resolved = resolve(ctx.resources, model);
  for (const m of resolved) {
    adapterFor(ctx.adapters, "llm", m);
    checkSettings(m);
  }
  return resolved;
}

const providerOf = (id: string) => id.slice(0, id.indexOf("/"));

/**
 * State goes back to models of the provider that wrote it (`same`: only to
 * the model itself); another provider's is left out.
 */
const stateFor = (id: string, same: "provider" | "model") => (message: LlmMessage) => {
  const by = message.role === "assistant" ? message.state?.by : undefined;
  if (!by || (same === "model" ? by === id : providerOf(by) === providerOf(id))) return message;
  const { state: _, ...rest } = message as Extract<LlmMessage, { role: "assistant" }>;
  return rest;
};

/** A provider refusing the request as given: worth one try without another model's state. */
const refused = (error: unknown) => (error as { status?: number }).status === 400;

/**
 * Streams a model's answer: text, tool calls, state and usage, as they come.
 * A call that breaks (the network, nothing coming for the provider's
 * `silence`, a provider timing out or busy) is tried again, longer waits
 * apart, for the provider's `retry`: a `retry` chunk says what came is void,
 * and when it tries next. With a list, a model that fails before writing
 * anything hands over to the next at once (the last one is tried again). A provider's thinking goes back to any of
 * its models; if one refuses another model's, the call is made again with
 * its own only.
 */
export async function* generate(ctx: Reach, request: Generate): AsyncGenerator<LlmChunk> {
  const choices = chooseModels(ctx, request.model);
  for (const [i, m] of choices.entries()) {
    const adapter = adapterFor<LlmAdapter>(ctx.adapters, "llm", m);
    const { effort, maxTokens, temperature, options } = m.settings as LlmSettings;
    // What this model reads besides text, that its adapter can send.
    const reads = (m.settings.input as Media[] | undefined) ?? m.info?.input ?? [];
    const media = reads.filter((medium) => adapter.media?.includes(medium));
    const borrowed = request.messages.some((message) =>
      message.role === "assistant" && message.state?.by && message.state.by !== m.id &&
      providerOf(message.state.by) === providerOf(m.id)
    );
    let wrote = false;
    // A broken call is tried again, waiting longer each time, until `retry` ms have gone by.
    const { silence = SILENCE, retry = RETRY } = m.endpoint as Provider;
    const until = Date.now() + retry;
    const sames = borrowed ? ["provider", "model"] as const : ["model"] as const;
    for (let s = 0, attempt = 0;;) {
      const same = sames[s];
      const call = measure(ctx.metrics, m, "chat");
      const quiet = new AbortController();
      try {
        for await (
          const chunk of quietly(
            adapter.generate({
              connection: { ...calledBy(m.endpoint, ctx), model: m.model },
              effort,
              maxTokens,
              temperature,
              options,
              info: m.info,
              instructions: request.instructions,
              messages: filesFor(media, request.messages.map(stateFor(m.id, same))),
              tools: request.tools ?? [],
              signal: AbortSignal.any([ctx.signal, quiet.signal]),
            }),
            silence,
            quiet,
          )
        ) {
          if (chunk.type === "state") {
            yield { type: "state", state: { by: m.id, data: chunk.state.data } };
          } else if (chunk.type === "usage") {
            const { type: _, model: __, ...quantities } = chunk;
            call.usage(quantities);
            // Every call tells who listens (the usage ledger), wherever it's made.
            await used(ctx, {
              meter: "llm",
              subject: m.id,
              catalog: m.catalog,
              quantities,
              tags: m.tags ? { ...m.tags, ...request.tags } : request.tags,
            });
            yield { ...chunk, model: m.id };
          } else {
            wrote = true;
            call.first();
            yield chunk;
          }
        }
        call.end();
        return;
      } catch (error) {
        call.end(error);
        if (ctx.signal.aborted) throw error;
        // With another model to hand over to, and nothing written, it hands over instead.
        const pause = backoff(attempt + 1);
        const alone = i === choices.length - 1 || wrote;
        if (alone && transient(error) && Date.now() + pause <= until) {
          attempt++;
          yield { type: "retry", attempt, wait: pause, reason: (error as Error).message };
          await wait(pause, ctx.signal);
          if (ctx.signal.aborted) throw error;
          wrote = false;
          continue;
        }
        // A break it tried again for as long as it should is final: nobody tries it again.
        const out = transient(error) ? Object.assign(error as Error, { final: true }) : error;
        if (wrote) throw out;
        if (same === "provider" && refused(error) && s + 1 < sames.length) {
          s++;
          continue;
        }
        if (i === choices.length - 1) throw out;
        break;
      }
    }
  }
}

/** The whole answer at once. `onText` hears the text as it streams (again, after a retry). */
export async function complete(
  ctx: Reach,
  request: Generate,
  onText?: (text: string) => void,
): Promise<Completion> {
  const answer: Completion = { text: "", toolCalls: [] };
  for await (const chunk of generate(ctx, request)) {
    if (chunk.type === "text") {
      answer.text += chunk.text;
      onText?.(chunk.text);
    } else if (chunk.type === "tool_call") answer.toolCalls.push(chunk.call);
    else if (chunk.type === "state") answer.state = chunk.state;
    else if (chunk.type === "retry") {
      // What came before the break is void: the answer starts over.
      answer.text = "";
      answer.toolCalls = [];
      delete answer.state;
    } else {
      const { type: _, ...usage } = chunk;
      answer.usage = usage;
    }
  }
  return answer;
}
