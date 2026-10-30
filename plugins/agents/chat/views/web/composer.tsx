/// <reference lib="dom" />
/**
 * Where you type. Enter sends, Shift+Enter starts a new line, Escape stops
 * the agents working. It grows with what you write, and takes files from the
 * clip, a paste or a drop, and a voice message from the microphone: recorded
 * here, listened back, then sent, with words or without. Audio is
 * transcribed as it's sent, which says so; if that fails, nothing went, and
 * it offers to retry or to send the audio alone. While agents work, it says
 * who, with Stop. After sending, you type on.
 *
 * Typing `@` lists the agents here (`agents`: each with its emoji, name and
 * what it does), narrowed as you type; ↑ ↓ move, Enter or Tab puts the one
 * chosen in (`@maya `), Escape closes it. A message refused for a reason
 * another front end can help with (`refusals`, by its code: `not_here`, it
 * named agents that don't answer here) shows that front end's View over the
 * box, with what was typed and a way to send it again: nothing went, and
 * what was typed stays.
 */
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Autocomplete,
  Avatar,
  Button,
  Chip,
  Icon,
  IconButton,
  Kbd,
  LazyView,
  message,
  optionId,
  Spinner,
  Textarea,
} from "../../../../../hosts/web/mod.ts";
import type { RefusalView } from "../../shared/types.ts";
import { matching, mention, type Mentionable, typingAt, unanswered } from "./agents.ts";
import { type Attached, chosen, FILES, read, size } from "./attach.ts";
import { record, type Recorder as Recording } from "./record.ts";
import { Recorder } from "./recorder.tsx";
import { VoiceFailed } from "./voice-failed.tsx";
import { names } from "./who.ts";

/** A file as `chat.send` takes it; a voice message's says how long it runs, and its peaks. */
export type Sent = {
  name: string;
  type: string;
  data: string;
  voice?: { duration: number; peaks?: number[] };
};

/** How it's sent: `transcribe: false` sends audio without a transcript. */
export type SendOptions = { transcribe?: boolean };

/** How many agents `@` lists at most. */
const LISTED = 8;

/** A send refused for a reason another front end's View helps with: that View, and what for. */
type Refused = { view: string; names: string[]; text: string; message: string };

const silent = () => () => {};
const none = () => undefined;
const audio = (type: string) => type.startsWith("audio/");
/** Why transcribing failed, without what the notice already says. */
const reason = (error: unknown) => message(error).replace(/^Couldn't transcribe [^:]*:\s*/, "");

export function Composer(props: {
  send(text: string, files: Sent[], options: SendOptions): Promise<void>;
  /** Agents writing right now. */
  working?: string[];
  stop?(): Promise<unknown>;
  placeholder?: string;
  /** What to start with, offered under it while it's empty. */
  suggestions?: string[];
  /** A line under it: where what you send goes. */
  note?: ReactNode;
  /** What's typed already when it opens (`@maya `, asked from an agent's page). */
  initial?: string;
  /** The agents here, for `@` to list: who answers new chats first. */
  agents?: Mentionable[];
  /** Where they work, as the list's heading says it ("Launch"). */
  where?: string;
  /** By the code a send is refused with, the View to show over the box (`refusals`). */
  refusals?: Record<string, RefusalView | null>;
  /** Where it sends, for those Views: the chat (none from home) and its space. */
  place?: { thread?: string; in?: string };
}): ReactNode {
  const [text, setText] = useState(props.initial ?? "");
  const [files, setFiles] = useState<Attached[]>([]);
  const [recorder, setRecorder] = useState<Recording>();
  const recording = useSyncExternalStore(recorder?.subscribe ?? silent, recorder?.get ?? none);
  const [sending, setSending] = useState<false | "sending" | "transcribing">(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  /** Why the audio couldn't be transcribed: nothing was sent. */
  const [failed, setFailed] = useState<string>();
  /** A refusal another front end's View helps with: nothing was sent. */
  const [refused, setRefused] = useState<Refused>();
  /** Where the caret is, for the `@name` being typed. */
  const [caret, setCaret] = useState(props.initial?.length ?? 0);
  /** The agent the list's keys are on, and the `@name` Escape closed it for (where it starts). */
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState<number>();
  const [over, setOver] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const mic = useRef<HTMLDivElement>(null);
  const previews = useRef(new Set<string>());
  const id = useId();
  const working = props.working ?? [];
  const phase = recording?.phase;
  const live = phase === "starting" || phase === "recording" || phase === "stopping";
  const take = phase === "review" ? recording?.take : undefined;
  const fine = () => matchMedia("(pointer: fine)").matches;

  // Ready to type after what's there, where there's a keyboard (on a phone, it waits for a tap).
  useEffect(() => {
    if (fine()) {
      area.current?.focus();
      area.current?.setSelectionRange(text.length, text.length);
    }
    const made = previews.current;
    return () => made.forEach((url) => URL.revokeObjectURL(url));
  }, []);
  useEffect(() => {
    if (!working.length) setStopping(false);
  }, [working.length]);
  // A recording replaced, sent or left behind lets the microphone go.
  useEffect(() => () => recorder?.cancel(), [recorder]);
  // Stopped, it waits to be sent: words may go with it.
  useEffect(() => {
    if (phase === "review") typeOn();
  }, [phase]);

  const add = (list: Iterable<File>) => {
    const picked = [...list].slice(0, Math.max(0, FILES - files.length - (take ? 1 : 0)));
    const fresh = picked.map(chosen);
    for (const f of fresh) if (f.preview) previews.current.add(f.preview);
    setFiles((now) => [...now, ...fresh]);
    fresh.forEach((f, i) => {
      if (f.error) return;
      read(picked[i]).then(
        (data) => setFiles((now) => now.map((x) => x.id === f.id ? { ...x, data } : x)),
        () =>
          setFiles((now) =>
            now.map((x) => x.id === f.id ? { ...x, error: "Couldn't read it" } : x)
          ),
      );
    });
  };
  const typeOn = () => requestAnimationFrame(() => fine() && area.current?.focus());
  const remove = (gone: Attached) => {
    if (gone.preview) URL.revokeObjectURL(gone.preview);
    setFiles((now) => now.filter((x) => x.id !== gone.id));
    setFailed(undefined);
    area.current?.focus();
  };

  // Recording starts inside the click: the microphone is asked for then, and only then.
  const startRecording = () => {
    setFailed(undefined);
    setError(undefined);
    setRecorder(record());
  };
  const dropRecording = () => {
    setRecorder(undefined);
    setFailed(undefined);
    requestAnimationFrame(() =>
      fine() ? area.current?.focus() : mic.current?.querySelector("button")?.focus()
    );
  };

  const reading = files.some((f) => !f.data && !f.error);
  const blocked = !!sending || reading || files.some((f) => f.error);
  const ready = !blocked && !live && (!!text.trim() || files.length > 0 || !!take);

  // The `@name` being typed, and the agents it could be.
  const typing = props.agents?.length && !live && !sending ? typingAt(text, caret) : undefined;
  const found = typing ? matching(props.agents ?? [], typing.query).slice(0, LISTED) : [];
  const listing = !!typing && typing.start !== closed && found.length > 0;
  const list = `${id}-agents`;
  useEffect(() => setActive(0), [typing?.query, typing?.start]);
  // Out of the `@name` Escape closed the list for, it opens again for the next.
  useEffect(() => {
    if (!typing) setClosed(undefined);
  }, [!!typing]);
  const pick = (agent: string) => {
    if (!typing) return;
    const next = mention(text, typing, agent);
    setText(next.text);
    setCaret(next.caret);
    setRefused(undefined);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = async (options: SendOptions = {}) => {
    let voice = take;
    // Send while recording: it stops, and goes as it is.
    if (phase === "recording" && recorder && !blocked) {
      voice = await recorder.stop();
      if (!voice) return;
    } else if (!ready) return;
    const transcribing = options.transcribe !== false &&
      (!!voice || files.some((f) => audio(f.type)));
    setSending(transcribing ? "transcribing" : "sending");
    setError(undefined);
    setFailed(undefined);
    setRefused(undefined);
    try {
      const sent: Sent[] = files.map((f) => ({ name: f.name, type: f.type, data: f.data! }));
      if (voice) {
        sent.unshift({
          name: voice.name,
          type: voice.type,
          data: await read(voice.blob),
          voice: {
            duration: voice.duration,
            ...(voice.peaks.length ? { peaks: voice.peaks } : {}),
          },
        });
      }
      await props.send(text.trim(), sent, options);
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      setText("");
      setFiles([]);
      setRecorder(undefined);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "";
      const view = props.refusals?.[code]?.view;
      if (code === "transcription_failed") setFailed(reason(e));
      else if (view) {
        // The names it mentioned that don't answer here (as the refusal says, if it does).
        const named = (e as { agents?: string[] }).agents ??
          unanswered(text, (props.agents ?? []).map((a) => a.id));
        setRefused({ view, names: named, text: text.trim(), message: message(e) });
      } else setError(message(e));
    } finally {
      setSending(false);
      typeOn();
    }
  };
  // What a refusal's View may do: send what's typed again, as it is, or go away.
  const latest = useRef(submit);
  latest.current = submit;
  const again = useRef({
    resend: async () => {
      setRefused(undefined);
      await latest.current();
    },
    dismiss: () => {
      setRefused(undefined);
      typeOn();
    },
  }).current;

  const stop = async () => {
    if (stopping || !props.stop) return;
    setStopping(true);
    try {
      await props.stop();
    } catch (e) {
      setError(message(e));
      setStopping(false);
    }
  };

  // Escape stops them from anywhere that isn't a field (after a click in the conversation).
  const latestStop = useRef(stop);
  latestStop.current = stop;
  useEffect(() => {
    if (!working.length) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && event.target === document.body) {
        void latestStop.current();
      }
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, [working.length > 0]);
  // While recording, Escape cancels it, before it would stop the agents.
  const latestDrop = useRef(dropRecording);
  latestDrop.current = dropRecording;
  useEffect(() => {
    if (!live) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      latestDrop.current();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [live]);

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // While `@` lists agents, its keys are the list's.
    if (listing && !event.nativeEvent.isComposing) {
      const move = { ArrowDown: 1, ArrowUp: -1 }[event.key as "ArrowDown" | "ArrowUp"];
      if (move) {
        event.preventDefault();
        return setActive((at) => (at + move + found.length) % found.length);
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        return pick(found[Math.min(active, found.length - 1)].id);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        return setClosed(typing!.start);
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && working.length) {
      event.preventDefault();
      void stop();
    }
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.files;
    if (pasted.length && !event.clipboardData.getData("text/plain")) {
      event.preventDefault();
      add(pasted);
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (event.dataTransfer.files.length) add(event.dataTransfer.files);
  };

  const status = sending === "transcribing"
    ? (
      <div className="chat-status" role="status">
        <Spinner size={13} className="chat-status-spin" />
        <span className="chat-status-text">
          Transcribing {take || phase === "stopping" ? "your recording" : "the audio"}…
        </span>
      </div>
    )
    : working.length
    ? (
      <div className="chat-status" role="status">
        <Spinner variant="dots" className="chat-status-dots" />
        <span className="chat-status-text">
          <b>{names(working)}</b> {working.length > 1 ? "are" : "is"} working…
        </span>
        <Button
          size="sm"
          className="chat-stop"
          onClick={() => void stop()}
          disabled={stopping}
        >
          <Icon name="stop" size={11} filled />
          {stopping ? "Stopping…" : "Stop"}
          <Kbd>Esc</Kbd>
        </Button>
      </div>
    )
    : null;

  return (
    <form
      className="chat-composer"
      aria-label="Send a message"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="chat-composer-inner">
        {status}
        {refused
          ? (
            <div className="chat-refusal">
              <LazyView
                kind={refused.view}
                item={{}}
                hints={{
                  ...props.place,
                  names: refused.names,
                  text: refused.text,
                  message: refused.message,
                  ...again,
                }}
                fallback={null}
              />
            </div>
          )
          : null}
        {failed
          ? (
            <VoiceFailed
              why={failed}
              recorded={!!take}
              busy={!!sending}
              onRetry={() => void submit()}
              onAudioOnly={() => void submit({ transcribe: false })}
            />
          )
          : null}
        <div
          ref={box}
          className={`chat-box${over ? " chat-box-over" : ""}${live ? " chat-box-live" : ""}`}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
          }}
          onDrop={drop}
        >
          {files.length
            ? (
              <ul className="chat-attached" aria-label="Files to send">
                {files.map((f) => (
                  <li
                    key={f.id}
                    className={`chat-attached-file${f.error ? " chat-attached-bad" : ""}`}
                  >
                    {f.preview
                      ? <img src={f.preview} alt="" />
                      : (
                        <span className="chat-attached-icon">
                          <Icon name={audio(f.type) ? "waveform" : "file"} size={16} />
                        </span>
                      )}
                    <span className="chat-attached-name">
                      <span>{f.name}</span>
                      <small>{f.error ?? (f.data ? size(f.size) : "Reading…")}</small>
                    </span>
                    <IconButton
                      icon="close"
                      size="sm"
                      label={`Remove ${f.name}`}
                      onClick={() => remove(f)}
                      disabled={!!sending}
                    />
                  </li>
                ))}
              </ul>
            )
            : null}
          {recording
            ? (
              <Recorder
                state={recording}
                busy={!!sending}
                focus
                onStop={() => void recorder?.stop()}
                onSend={() => void submit()}
                onDelete={dropRecording}
                onRestart={startRecording}
              />
            )
            : null}
          <div className="chat-box-text" hidden={live}>
            <label className="copilotz-sr" htmlFor={id}>Message</label>
            <Textarea
              id={id}
              ref={area}
              rows={1}
              bare
              autoGrow
              className="chat-input"
              value={text}
              placeholder={take ? "Add a message, or just send it" : props.placeholder ?? "Message"}
              enterKeyHint="send"
              readOnly={!!sending}
              aria-autocomplete={props.agents?.length ? "list" : undefined}
              aria-controls={props.agents?.length ? list : undefined}
              aria-activedescendant={listing ? optionId(list, active) : undefined}
              onChange={(event) => {
                setText(event.target.value);
                setCaret(event.target.selectionStart);
                setRefused(undefined);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onKeyDown={keys}
              onPaste={paste}
            />
            {props.agents?.length
              ? (
                <Autocomplete
                  id={list}
                  target={box}
                  open={listing}
                  label={props.where ? `Agents in ${props.where}` : "Agents here"}
                  title={props.where ? `Agents in ${props.where}` : "Agents here"}
                  active={active}
                  onActive={setActive}
                  onPick={(option) => pick(option.key)}
                  options={found.map((a) => ({
                    key: a.id,
                    leading: <Avatar name={a.name} kind="agent" icon={a.icon} size={28} />,
                    label: (
                      <>
                        {a.name} <span className="chat-mention-handle">@{a.id}</span>
                      </>
                    ),
                    ...(a.description ? { description: a.description } : {}),
                  }))}
                />
              )
              : null}
            <div className="chat-box-row">
              <IconButton
                icon="attach"
                label="Attach files"
                disabled={files.length + (take ? 1 : 0) >= FILES || !!sending}
                onClick={() => picker.current?.click()}
              />
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files) add(event.target.files);
                  event.target.value = "";
                }}
              />
              <div className="chat-box-end" ref={mic}>
                {recording ? null : (
                  <IconButton
                    icon="mic"
                    label="Record a voice message"
                    onClick={startRecording}
                    disabled={!!sending || files.length >= FILES}
                  />
                )}
                <IconButton
                  type="submit"
                  icon="send"
                  label="Send"
                  variant="primary"
                  className="chat-send"
                  loading={!!sending}
                  disabled={!ready}
                />
              </div>
            </div>
          </div>
        </div>
        {error ? <p role="alert" className="chat-error">{error}</p> : null}
        {props.suggestions?.length && !text && !files.length && !recording
          ? (
            <ul className="chat-suggestions" aria-label="Suggestions">
              {props.suggestions.map((s) => (
                <li key={s}>
                  <Chip
                    variant="outline"
                    size="lg"
                    onClick={() => {
                      setText(s);
                      requestAnimationFrame(() => {
                        area.current?.focus();
                        area.current?.setSelectionRange(s.length, s.length);
                      });
                    }}
                  >
                    {s}
                  </Chip>
                </li>
              ))}
            </ul>
          )
          : null}
        <p className="chat-hint">
          {props.note}
          <span className="chat-keys">
            <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line
          </span>
        </p>
      </div>
    </form>
  );
}
