/**
 * Chat's layout on the web: a chat and its messages, what agents wait on you
 * for (over where you type, and in the sidebar), the composer, home, a
 * space's chats (its tab) and its latest (in the sidebar), and a contact's
 * chat's staff notes beside it. Only layout, on the theme's variables; the
 * pieces (buttons, chips, notices, markdown…) are the web host's toolkit.
 */
export const STYLE = `
.chat { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--background);
  --notes-tint: color-mix(in oklab, var(--warning) 6%, var(--background));
  --notes-soft: color-mix(in oklab, var(--warning) 15%, var(--background));
  --notes-line: color-mix(in oklab, var(--warning) 24%, var(--border));
  --notes-ink: var(--warning-text); }
/* Under the header: the conversation, and its staff notes beside it while they're open */
.chat-split { position: relative; flex: 1; min-height: 0; display: flex; container: chat-split / inline-size; }
.chat-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

/* The header */
.chat-head { flex: none; display: flex; align-items: center; gap: 12px; min-height: 58px;
  padding: 9px max(16px, var(--copilotz-inset-end, 0px)) 9px max(24px, var(--copilotz-inset, 0px));
  border-bottom: 1px solid var(--border); }
.chat-head-text { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.chat-head h1 { margin: 0; min-width: 0; font-family: var(--font-display); font-size: 16px; font-weight: 620;
  letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-space { flex: none; }
.chat-people { flex: none; display: flex; align-items: center; padding-left: 6px; }
.chat-people > * { margin-left: -6px; outline: 2px solid var(--background); }
.chat-people-more { min-width: 26px; min-height: 26px; }
.chat-head-new { display: none; }

/* What was said */
.chat-body { position: relative; flex: 1; min-height: 0; display: flex; }
/* It scrolls up and down only: what's wider (a table, code) scrolls in its own box, text wraps. */
.chat-transcript { flex: 1; min-width: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--input) transparent; }
.chat-log { max-width: 800px; margin: 0 auto; padding: 28px 24px 36px; display: flex; flex-direction: column; }
.chat-jump { position: absolute; z-index: 5; bottom: 14px; left: 50%; transform: translateX(-50%);
  border-radius: var(--radius-full); box-shadow: var(--shadow-md); animation: chat-rise .2s ease-out; }
@keyframes chat-rise { from { opacity: 0; transform: translate(-50%, 6px); } }

/* A message */
.msg { display: grid; grid-template-columns: 30px minmax(0, 1fr); column-gap: 14px; margin-top: 22px; }
.msg:first-child { margin-top: 0; }
.msg-follows { margin-top: 6px; }
.msg-gutter { padding-top: 1px; }
.msg-main { min-width: 0; }
.msg-head { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 8px; min-height: 22px;
  margin-bottom: 3px; font-size: 13.5px; line-height: 1.4; }
.msg-name { font-weight: 650; color: var(--foreground); }
a.msg-name { text-decoration: none; }
a.msg-name:hover { text-decoration: underline; text-underline-offset: 3px;
  text-decoration-color: color-mix(in oklab, currentColor 35%, transparent); }
.msg-to { color: var(--muted-foreground); font-size: 12.5px; }
.msg-head-again { min-height: 0; margin: 10px 0 2px; }
.msg-writing { color: var(--primary-text); font-size: 12px; font-weight: 560; }
.msg-writing::after { content: "…"; }
.msg-body { overflow-wrap: anywhere; }
.msg-via { margin-bottom: 5px; }
.msg-bubble { display: inline-block; max-width: min(100%, 640px); padding: 9px 15px; background: var(--muted);
  border-radius: var(--radius-xs) var(--radius-2xl) var(--radius-2xl) var(--radius-2xl);
  white-space: pre-wrap; line-height: 1.5; }
.msg-mine { grid-template-columns: minmax(0, 1fr); justify-items: end; margin-top: 26px; }
.msg-mine.msg-follows { margin-top: 6px; }
.msg-mine .msg-main { position: relative; display: flex; flex-direction: column; align-items: flex-end;
  max-width: min(86%, 640px); }
.msg-mine .msg-bubble { background: var(--bubble); color: var(--bubble-foreground);
  border-radius: var(--radius-2xl) var(--radius-2xl) var(--radius-xs) var(--radius-2xl); }
.msg-mine .msg-head { justify-content: flex-end; min-height: 0; margin: 0 4px 4px; }
.msg-mine-time { position: absolute; right: calc(100% + 10px); bottom: 6px; opacity: 0; transition: opacity .15s; }
.msg-mine:hover .msg-mine-time, .msg-mine:focus-within .msg-mine-time { opacity: 1; }
.msg-aside { margin-left: 44px; padding-left: 14px; border-left: 2px solid var(--border); font-size: 14.5px; }
.msg-aside.msg-mine { margin-left: 0; padding-left: 0; border-left: 0; }
.msg-aside .msg-gutter .copilotz-avatar { --size: 24px !important; }
.msg:has(> .msg-main > .msg-actions) { padding-bottom: 8px; }
.msg-main:has(> .msg-actions) { position: relative; }
.msg-actions { position: absolute; top: 100%; left: -6px; display: flex; gap: 2px; margin-top: 2px;
  opacity: 0; transition: opacity .15s; }
.msg:hover .msg-actions, .msg:focus-within .msg-actions, .msg-actions-shown { opacity: 1; }
.msg-mine .msg-actions { left: auto; right: -6px; }
@media (hover: none) {
  .msg:has(> .msg-main > .msg-actions) { padding-bottom: 0; }
  .msg-actions { position: static; opacity: 1; margin: 2px 0 0 -6px; }
}
.msg-note { display: flex; align-items: center; gap: 6px; margin: 6px 0 0; color: var(--muted-foreground);
  font-size: 12.5px; }
.msg-asked { margin-top: 8px; }
.msg-files { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; max-width: 100%;
  margin-top: 8px; }
.msg-mine .msg-files { justify-content: flex-end; }

/* A step: the tools an agent called */
.msg-step > .copilotz-md { margin-bottom: 8px; }
.step-what { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step-what b, .live-calls b { font: 600 12.5px var(--font-mono); }
.step-what b.step-who, .live-calls b.step-who { font: 600 13px var(--font-sans); }
.step-chevron { display: inline-grid; color: var(--muted-foreground); transition: transform .15s; }
.step[open] .step-chevron { transform: rotate(90deg); }
.step-calls { display: grid; gap: 8px; margin-top: 10px; }
.step-shown { display: grid; gap: 8px; margin: 2px 0 8px; min-width: 0; }
.step-shown + .step { margin-top: 2px; }
.step-call { overflow: hidden; }
.step-call > header { padding: 7px 12px; border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 50%, var(--card)); font: 600 12.5px/1.4 var(--font-mono); }
.step-io { display: grid; grid-template-columns: 56px minmax(0, 1fr); }
.step-io + .step-io { border-top: 1px dashed var(--border); }
.step-io > span { padding: 9px 0 0 12px; color: var(--muted-foreground); font-size: 11.5px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .05em; }
.step-io pre { margin: 0; padding: 8px 12px; max-height: 260px; overflow: auto; white-space: pre-wrap;
  overflow-wrap: anywhere; font: 12.5px/1.55 var(--font-mono); font-variant-ligatures: none; }

/* Being written */
.live-calls { list-style: none; display: grid; gap: 6px; margin: 2px 0 8px; padding: 0; }
.live-calls li { display: flex; align-items: center; gap: 8px; color: var(--secondary-foreground); font-size: 13px; }
.live-calls li > span { min-width: 0; overflow-wrap: anywhere; }
.live-calls li[data-done] .copilotz-icon { color: var(--success); }
.live-spinner { color: var(--primary-text); }
.chat-thinking { height: 26px; color: var(--muted-foreground); }
/* A model's call that broke, tried again: what came stays, dimmed, under how long until the next */
.live-stale { opacity: .45; transition: opacity .3s; }
.live-retry { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 6px 0 0;
  color: var(--muted-foreground); font-size: 13px; font-variant-numeric: tabular-nums;
  animation: chat-fade .2s ease-out; }
.live-retry-icon { flex: none; }
.live-retry-try { padding: 0 7px; border-radius: var(--radius-full); background: var(--muted); font-size: 12px; }
.live-retry-why { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: var(--radius-full);
  color: var(--muted-foreground); cursor: help; opacity: .8; }
.live-retry-why:hover, .live-retry-why:focus-visible { opacity: 1; background: var(--muted); }

/* A message of yours waiting for its agents to finish an earlier one */
.msg-queued { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: baseline; gap: 2px 7px;
  margin: 5px 4px 0; color: var(--muted-foreground); font-size: 12.5px; animation: chat-fade .2s ease-out; }
.msg-queued .copilotz-button { min-height: 0; padding: 0; font-size: 12.5px; }

/* Files */
.file-picture { display: block; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-xl);
  overflow: hidden; background: var(--muted); cursor: zoom-in; }
.file-picture img { display: block; max-width: min(320px, 100%); max-height: 240px; object-fit: cover; }
.file-view { display: grid; margin: 0; }
.file-view img { display: block; max-width: 100%; max-height: calc(92vh - 52px); margin: 0 auto; object-fit: contain; }
.file-view figcaption { display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 16px; font-size: 13.5px; }
.file-view figcaption span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-chip { display: inline-flex; align-items: center; gap: 10px; max-width: min(300px, 100%); padding: 8px 10px 8px 8px; }
.file-chip-icon { display: grid; place-items: center; flex: none; width: 36px; height: 36px;
  border-radius: var(--radius-md); background: var(--primary-soft); color: var(--primary-text); }
.file-chip-text { display: grid; min-width: 0; line-height: 1.3; }
.file-chip-name { font-size: 13.5px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-chip small { color: var(--muted-foreground); font-size: 12px; }
.file-chip-save { margin-left: 4px; color: var(--muted-foreground); }

/* A voice message, or audio, on a message */
.msg-mine .voice-note { border-radius: var(--radius-2xl) var(--radius-2xl) var(--radius-xs) var(--radius-2xl); }
.msg-person .voice-note, .msg-agent .voice-note {
  border-radius: var(--radius-xs) var(--radius-2xl) var(--radius-2xl) var(--radius-2xl); }
.msg-follows .voice-note { border-radius: var(--radius-2xl); }
.msg-main > .msg-files:nth-child(1), .msg-head + .msg-files { margin-top: 0; }
.voice-note-file { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 2px; font-size: 12.5px; }
.voice-note-file span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 560; }
.voice-note-file small { flex: none; opacity: .7; font-size: 12px; }
.voice-note-file .copilotz-icon-button { margin-left: auto; color: inherit; }
.voice-said { display: grid; justify-items: start; margin: 2px 0 3px; }
.voice-said-toggle { display: inline-flex; align-items: center; gap: 3px; margin-left: -5px;
  padding: 3px 7px 3px 3px; border: 0; border-radius: var(--radius-sm); background: none; color: inherit; font-size: 12.5px; font-weight: 580;
  opacity: .72; cursor: pointer; transition: opacity .15s, background-color .15s; }
.voice-said-toggle:hover { opacity: 1; background: color-mix(in oklab, currentColor 8%, transparent); }
.voice-said-toggle .copilotz-icon { transition: transform .15s; }
.voice-said-toggle[aria-expanded=true] .copilotz-icon { transform: rotate(90deg); }
.voice-said-text { margin: 1px 0 2px; font-size: 14px; line-height: 1.5; white-space: pre-wrap;
  overflow-wrap: anywhere; }

/* Over where you type: what other front ends ask here (the conversation resource) */
/* However much it asks, the conversation keeps some room, and what's asked scrolls in its own. */
.chat-asks { flex: none; display: grid; gap: 8px; width: 100%; max-width: 848px; max-height: 60%; margin: 0 auto;
  padding: 2px 24px 10px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin;
  scrollbar-color: var(--input) transparent; }
.chat-asks:empty, .chat-asks .copilotz-loading { display: none; }

/* What agents wait on you for: a card each, what's asked, then only the answers it takes */
.asks { display: grid; gap: 8px; }
.asks > .ask { animation: ask-in .36s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes ask-in { from { opacity: 0; transform: translateY(8px); } }
.ask { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 12px 14px 12px 12px;
  border-color: var(--warning-border); box-shadow: var(--shadow-md); }
.ask-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md);
  background: var(--warning-soft); color: var(--warning-text); }
.ask-main { display: grid; gap: 9px; min-width: 0; }
.ask-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; margin: 4px 0 0; font-size: 14.5px; }
.ask-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; margin-top: 4px; }
.ask-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.ask-where { margin-left: auto; color: var(--muted-foreground); font-size: 12.5px; white-space: nowrap; }
.ask-where .copilotz-time { font-size: 12.5px; }
/* Who'd see it, then, quieter, why it's asked */
.ask-seen { display: flex; align-items: center; gap: 6px; margin: -3px 0 0; font-size: 13.5px; }
.ask-seen .copilotz-icon { flex: none; color: var(--muted-foreground); }
.ask-why { margin: -5px 0 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.45; }
/* What it would say: a calm quote, a few lines until it's opened */
.ask-quote { margin: 0; padding: 8px 12px; border-left: 3px solid var(--warning-border);
  border-radius: 0 var(--radius-md) var(--radius-md) 0; background: var(--muted); font-size: 13.5px; line-height: 1.5; }
.ask-quote .copilotz-long-text-toggle { margin-top: 2px; }
.ask-answers { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ask-answers .copilotz-button { position: relative; }
/* Saying no, or keeping it to yourself, sits apart */
.ask-apart { margin-left: auto; }
.ask-deny { color: var(--destructive-text); }
/* Each answer's key, shown once the card has focus: 1, 2, 3… answer */
.ask-key { position: absolute; top: -7px; right: -7px; display: grid; place-items: center; min-width: 16px; height: 16px;
  padding: 0 4px; border: 1px solid var(--input); border-radius: var(--radius-full); background: var(--background);
  color: var(--muted-foreground); font: 600 10px/1 var(--font-sans); opacity: 0; transform: scale(.8);
  transition: opacity .12s, transform .12s; pointer-events: none; }
.ask:focus-within .ask-key { opacity: 1; transform: none; }
.ask-error { margin: 0; color: var(--destructive-text); font-size: 13px; }

/* The sidebar: what agents wait on you for in other chats */
.asks-waiting { list-style: none; display: grid; gap: 1px; margin: 0; padding: 0; }
.asks-waiting-mark { display: grid; place-items: center; flex: none; width: 22px; height: 22px;
  border-radius: var(--radius-full); background: var(--warning-soft); color: var(--warning-text);
  animation: asks-pulse 2.4s ease-in-out infinite; }
@keyframes asks-pulse { 50% { background: color-mix(in oklab, var(--warning) 26%, var(--sidebar)); } }
.asks-waiting-more { margin: 0 10px 4px 41px; color: var(--muted-foreground); font-size: 12px; }

/* Where you type */
.chat-composer { flex: none; padding: 0 24px max(14px, env(safe-area-inset-bottom));
  background: linear-gradient(to bottom, transparent, var(--background) 18px); }
.chat-composer-inner { max-width: 800px; margin: 0 auto; }
.chat-status { display: flex; align-items: center; gap: 10px; margin: 0 6px 8px; color: var(--muted-foreground);
  font-size: 13px; animation: chat-fade .2s ease-out; }
.chat-status-dots { color: var(--primary-text); }
.chat-status-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-status b { color: var(--secondary-foreground); font-weight: 600; }
.chat-stop { min-height: 28px; gap: 7px; padding: 0 6px 0 10px; border-radius: var(--radius-full); font-size: 12.5px; }
@keyframes chat-fade { from { opacity: 0; transform: translateY(3px); } }
.chat-box { display: flex; flex-direction: column; border: 1px solid var(--input); border-radius: var(--radius-3xl);
  background: var(--card); box-shadow: var(--shadow-md); outline: 3px solid transparent;
  transition: border-color .15s, outline-color .15s; }
.chat-box:focus-within { border-color: color-mix(in oklab, var(--ring) 40%, var(--input));
  outline-color: color-mix(in oklab, var(--ring) 9%, transparent); }
.chat-box-over { border-color: var(--ring); border-style: dashed; background: var(--primary-soft); }
.chat-box-live { border-color: color-mix(in oklab, var(--destructive) 35%, var(--input)); }
.chat-box-text[hidden] { display: none; }
.chat-input { min-height: 54px; padding: 15px 20px 4px; font-size: 15px; }
.chat-box-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 8px 10px; }
.chat-box-end { display: flex; align-items: center; gap: 4px; }
.chat-send { border-radius: var(--radius-full); }
.chat-status-spin { color: var(--primary-text); }

/* Recording a voice message */
.voice-rec { display: grid; gap: 4px; padding: 12px 8px 8px 10px; animation: chat-fade .15s ease-out; }
.voice-rec-meter { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 40px;
  padding: 0 12px 0 10px; }
.voice-rec-dot { flex: none; width: 10px; height: 10px; border-radius: var(--radius-full);
  background: var(--muted-foreground); opacity: .45; }
.voice-rec-dot-on { background: var(--destructive); opacity: 1; animation: voice-pulse 1.4s ease-in-out infinite; }
@keyframes voice-pulse { 50% { opacity: .3; } }
.voice-rec-time { flex: none; display: flex; align-items: baseline; gap: 5px; font-size: 15px; font-weight: 620;
  font-variant-numeric: tabular-nums; }
.voice-rec-wave { flex: 1; height: 34px; color: var(--foreground); }
.voice-rec-starting { flex: 1; display: flex; align-items: center; gap: 8px; color: var(--muted-foreground);
  font-size: 13.5px; }
.voice-rec-limit { color: var(--muted-foreground); font-size: 12.5px; font-weight: 450; }
.voice-rec-limit-soon { color: var(--warning-text); font-weight: 620; }
.voice-rec-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.voice-rec-end { display: flex; align-items: center; gap: 8px; }
.voice-rec-stop { gap: 7px; min-height: 34px; padding: 0 14px 0 12px; border-radius: var(--radius-full); }
.voice-take { margin: 12px 12px 0; padding: 7px 6px 7px 7px; border: 1px solid var(--border);
  border-radius: var(--radius-2xl); background: color-mix(in oklab, var(--muted) 55%, var(--card));
  animation: chat-fade .15s ease-out; }
.chat-attached + .voice-take { margin-top: 8px; }
.voice-take-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.voice-take-player { flex: 1; }
.voice-take-actions { flex: none; display: flex; gap: 2px; }
.voice-take-note { margin: 4px 4px 0 46px; color: var(--muted-foreground); font-size: 12px; }
.voice-error { display: flex; align-items: center; gap: 10px; margin: 12px 12px 0; padding: 7px 7px 7px 12px;
  border: 1px solid var(--destructive-border); border-radius: var(--radius-xl); background: var(--destructive-soft);
  color: var(--destructive-text); font-size: 13.5px; line-height: 1.4; animation: chat-fade .15s ease-out; }
.voice-error p { flex: 1; min-width: 0; margin: 0; }
.voice-error .copilotz-button { flex: none; }
.voice-failed { margin: 0 0 10px; animation: chat-fade .2s ease-out; }
.chat-refusal { margin: 0 0 10px; animation: chat-fade .2s ease-out; }
.chat-refusal:empty { display: none; }
.chat-notes { display: grid; gap: 6px; margin: 0 0 8px; animation: chat-fade .2s ease-out; }
.chat-notes:not(:has(.copilotz-notice)) { display: none; }
/* On home what's over the box takes no room, so the box doesn't move: the greeting glides up to make way */
.chat-home .chat-composer-inner { position: relative; }
.chat-home .chat-composer-inner:not(:has(.chat-refusal, .voice-failed)) .chat-notes { position: absolute; right: 0; bottom: 100%; left: 0; }
.chat-home-hero { transition: transform .2s ease-out; }
.chat-home-body:has(.chat-notes .copilotz-notice) .chat-home-hero { transform: translateY(-34px); }
.chat-mention-handle { color: var(--muted-foreground); font: 500 12px var(--font-mono); }
.chat-attached { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 12px 12px 0; }
.chat-attached-file { display: flex; align-items: center; gap: 8px; max-width: 260px; padding: 5px 4px 5px 5px;
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--muted) 50%, var(--card)); }
.chat-attached-file img, .chat-attached-icon { flex: none; width: 36px; height: 36px;
  border-radius: var(--radius-sm); object-fit: cover; }
.chat-attached-icon { display: grid; place-items: center; background: var(--primary-soft); color: var(--primary-text); }
.chat-attached-name { display: grid; min-width: 0; line-height: 1.3; }
.chat-attached-name span { font-size: 13px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-attached-name small { font-size: 11.5px; color: var(--muted-foreground); }
.chat-attached-bad { border-color: var(--destructive-border); background: var(--destructive-soft); }
.chat-attached-bad small { color: var(--destructive-text); }
.chat-error { margin: 8px 6px 0; color: var(--destructive-text); font-size: 13px; }
.chat-hint { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 6px 16px;
  margin: 9px 0 0; color: var(--muted-foreground); font-size: 12px; }
.chat-keys { display: inline-flex; align-items: center; gap: 4px; }
.chat-suggestions { list-style: none; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
  margin: 18px 0 0; padding: 0; }

/* Home */
.chat-home { overflow-y: auto; }
.chat-home-body { flex: 1; display: flex; flex-direction: column; justify-content: center; width: 100%;
  max-width: 760px; margin: 0 auto; padding: 48px 0 10vh; }
.chat-home .chat-composer { background: none; padding-bottom: 0; }
.chat-home-hero { display: grid; justify-items: center; gap: 4px; margin-bottom: 28px; padding: 0 24px;
  text-align: center; }
.chat-home-hero h1 { margin: 16px 0 0; font-family: var(--font-display); font-size: clamp(25px, 4vw, 32px);
  line-height: 1.2; letter-spacing: -.025em; font-weight: 680; }
.chat-home-hero p { margin: 0; color: var(--muted-foreground); font-size: 16px; }
.chat-home-hero b { color: var(--secondary-foreground); font-weight: 600; }
.chat-home-where { display: inline-flex; align-items: center; gap: 6px; }
.chat-home-top { display: grid; gap: 10px; margin: 0 0 32px; padding: 0 24px; }
.chat-home-top:empty, .chat-home-top > .copilotz-loading { display: none; }

/* Not here */
.chat-missing { display: grid; place-items: center; padding: 24px; }

/* The sidebar: starting one, and a space's latest under it */
.chat-new { width: 100%; justify-content: flex-start; min-height: 40px; padding: 0 12px; margin: 2px 0 4px; }
.chat-new[aria-current] { border-color: var(--primary-border); }
.chats-recent { list-style: none; display: grid; gap: 1px; margin: 0; padding: 0; }
.chats-recent .copilotz-nav-item { min-height: 32px; padding-block: 4px; font-size: 13.5px; }
.chats-recent .copilotz-nav-quiet { font-size: 13px; }
.chats-recent > .copilotz-skeleton { margin: 2px 0; }
.chats-recent-none { margin: 4px 10px 6px; color: var(--muted-foreground); font-size: 12.5px; }

/* A space's chats: its tab */
.chats { container: chats / inline-size; display: grid; gap: 18px; }
.chats-tools { display: flex; align-items: center; gap: 10px; }
.chats-search { flex: 1; }
.chats-group { display: grid; gap: 8px; }
.chats-group h3 { margin: 0 2px; color: var(--muted-foreground); font-size: 12px; font-weight: 650;
  letter-spacing: .06em; text-transform: uppercase; }
.chats-list { list-style: none; display: grid; margin: 0; padding: 4px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); }
.chats-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  min-height: 56px; padding: 8px 12px 8px 10px; border-radius: var(--radius-lg); color: inherit;
  text-decoration: none; transition: background-color .12s; }
.chats-row:hover { background: var(--accent); }
.chats-row-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-md);
  background: var(--primary-soft); color: var(--primary-text); }
.chats-row-text { display: grid; gap: 2px; min-width: 0; }
.chats-row-title, .chats-row-last { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chats-row-title { font-weight: 600; }
.chats-row-last { color: var(--muted-foreground); font-size: 13px; }
.chats-row-meta { display: grid; justify-items: end; gap: 2px; color: var(--muted-foreground); font-size: 12px;
  white-space: nowrap; }
.chats-row-meta .copilotz-time { font-size: 12px; }
.chats-item { position: relative; }
.chats-row-menu { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); opacity: 0;
  transition: opacity .12s; }
.chats-item:is(:hover, :focus-within) .chats-row-menu, .chats-row-menu:has([aria-expanded=true]) { opacity: 1; }
.chats-item:is(:hover, :focus-within) .chats-row-meta { visibility: hidden; }
@media (pointer: coarse) {
  .chats-row-menu { opacity: 1; right: 4px; }
  .chats-row { padding-right: 44px; }
  .chats-item:is(:hover, :focus-within) .chats-row-meta { visibility: visible; }
}
.chats-none { margin: 4px 2px; color: var(--muted-foreground); font-size: 13px; text-align: center; }
.chats-empty { margin: 40px auto 24px; }
.chats-compact { gap: 14px; }
.chats-compact .chats-list { padding: 2px; }
.chats-compact .chats-row { grid-template-columns: minmax(0, 1fr) auto; min-height: 48px; gap: 10px;
  padding: 6px 10px; }
.chats-compact .chats-row-title { font-size: 13.5px; }
.chats-compact .chats-row-last { font-size: 12.5px; }
@container chats (max-width: 480px) {
  .chats-tools .copilotz-button { padding: 0 12px; }
  .chats-row { grid-template-columns: minmax(0, 1fr) auto; padding-left: 12px; }
  .chats-row-icon, .chats-row-count { display: none; }
}

/* Staff notes: the team's own side of a contact's chat. A quiet warm tint and a lock, never an alarm. */
.notes-toggle { flex: none; gap: 6px; border-radius: var(--radius-full); }
.notes-toggle > .copilotz-icon, .notes-switch-notes > .copilotz-icon, .chat-mention-note .copilotz-button .copilotz-icon {
  color: var(--notes-ink); }
.notes-toggle[aria-expanded=true] { border-color: var(--notes-line); background: var(--notes-soft); }
.notes-count { min-width: 18px; margin-right: -3px; }
.notes-switch { display: none; }
.notes-lane { flex: none; display: flex; flex-direction: column; width: clamp(340px, 36%, 460px); min-height: 0;
  border-left: 1px solid var(--notes-line); background: var(--notes-tint); animation: notes-in .22s cubic-bezier(.2, .8, .2, 1); }
@keyframes notes-in { from { opacity: 0; transform: translateX(14px); } }
.notes-head { flex: none; display: flex; align-items: center; gap: 10px; min-height: 58px; padding: 9px 10px 9px 16px;
  border-bottom: 1px solid var(--notes-line); }
.notes-mark { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: var(--radius-full);
  background: var(--notes-soft); color: var(--notes-ink); }
.notes-mark-lg { width: 46px; height: 46px; }
.notes-head-text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.notes-head h2 { margin: 0; font-family: var(--font-display); font-size: 14.5px; font-weight: 650; line-height: 1.3; }
.notes-head p { margin: 0; overflow: hidden; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.35;
  text-overflow: ellipsis; white-space: nowrap; }
.notes-body, .notes-talk { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.notes-body > .copilotz-loading { flex: 1; }
.notes-loading { display: grid; gap: 10px; align-content: start; padding: 22px 16px; }
.notes-empty { flex: 1; display: grid; justify-items: center; align-content: center; gap: 8px; padding: 32px 28px;
  text-align: center; animation: chat-fade .2s ease-out; }
.notes-empty h3 { margin: 8px 0 0; font-family: var(--font-display); font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
.notes-empty p { max-width: 36ch; margin: 0; color: var(--muted-foreground); font-size: 13.5px; line-height: 1.55; }
.notes-talk .chat-log { padding: 18px 16px 26px; }
.notes-talk .msg { column-gap: 10px; grid-template-columns: 26px minmax(0, 1fr); }
.notes-talk .msg-gutter .copilotz-avatar { --size: 26px !important; }
.notes-talk .msg-mine { grid-template-columns: minmax(0, 1fr); }
.notes-talk .msg-aside { margin-left: 10px; padding-left: 10px; }
.notes-talk .msg-person .msg-bubble { background: var(--card); outline: 1px solid var(--notes-line); outline-offset: -1px; }
.notes-talk .chat-asks { padding: 2px 12px 8px; }
.notes-talk .chat-composer { padding: 0 12px max(12px, env(safe-area-inset-bottom));
  background: linear-gradient(to bottom, transparent, var(--notes-tint) 18px); }
.notes-talk .chat-input { min-height: 48px; padding: 13px 16px 4px; font-size: 14.5px; }
.notes-talk .chat-keys { display: none; }
.notes-hint, .chat-shared { display: inline-flex; align-items: center; gap: 5px; }
.notes-hint .copilotz-icon { color: var(--notes-ink); }
.notes-banner { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 16px 8px 24px;
  border-bottom: 1px solid var(--notes-line); background: var(--notes-tint); }
.notes-banner .notes-mark { width: 26px; height: 26px; }
.notes-banner p { flex: 1; min-width: 0; margin: 0; color: var(--muted-foreground); font-size: 13.5px; line-height: 1.4; }
.notes-banner b { color: var(--foreground); font-weight: 620; }
.notes-banner-only::before { content: "·"; margin: 0 7px; }
@container chat-split (max-width: 880px) {
  .notes-lane { position: absolute; z-index: 6; inset: 0 0 0 auto; width: min(100%, 420px); box-shadow: var(--shadow-lg); }
}
/* What's typed in a contact's chat names an agent: where it would answer */
.chat-mentioned { margin: 0 0 8px; animation: chat-fade .2s ease-out; }
/* A draft from the notes, sent on to the chat */
.msg-relay-open { min-height: 28px; padding: 0 8px; color: var(--muted-foreground); font-size: 12.5px; }
.msg-relay-open:hover { color: var(--foreground); }
.msg-relayed { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 8px;
  color: var(--success-text); font-size: 12.5px; font-weight: 560; animation: chat-fade .2s ease-out; }
.msg-relay { display: grid; gap: 8px; width: 100%; margin-top: 10px; padding: 10px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); box-shadow: var(--shadow-md); animation: chat-fade .15s ease-out; }
.msg-mine .msg-relay { align-self: stretch; min-width: min(320px, 100%); }
.msg-relay-text { min-height: 64px; font-size: 14px; }
.msg-relay-note { display: flex; align-items: center; gap: 6px; margin: 0 2px; color: var(--muted-foreground);
  font-size: 12.5px; line-height: 1.4; }
.msg-relay-note .copilotz-icon { flex: none; }
.msg-relay-row { display: flex; justify-content: flex-end; gap: 6px; }

@media (max-width: 760px) {
  .chat-head { padding-right: max(8px, var(--copilotz-inset-end, 0px)); gap: 8px; }
  .chat-head-new { display: inline-grid; }
  .chat-space { display: none; }
  .chat-people > :nth-child(n+3) { display: none; }
  .chat-log { padding: 20px 16px 28px; }
  .msg { column-gap: 10px; grid-template-columns: 26px minmax(0, 1fr); }
  .msg-gutter .copilotz-avatar { --size: 26px !important; }
  .msg-mine { grid-template-columns: minmax(0, 1fr); }
  .msg-aside { margin-left: 10px; padding-left: 10px; }
  .chat-composer { padding: 0 10px max(10px, env(safe-area-inset-bottom)); }
  .chat-asks { padding: 2px 10px 8px; }
  .ask { grid-template-columns: minmax(0, 1fr); padding: 12px; }
  .ask-icon, .ask-key { display: none; }
  .ask-head, .ask-top { margin: 0; }
  /* Two columns: the first yes and the answer apart, then the wider yeses (tooltips lay out as their buttons). */
  .ask-answers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ask-answers .copilotz-button { order: 2; min-width: 0; width: 100%; white-space: normal; text-align: center;
    line-height: 1.2; }
  .ask-answers > :first-child .copilotz-button { order: 0; }
  .ask-answers .ask-apart { order: 1; margin: 0; }
  .voice-rec-meter { gap: 10px; padding: 0 6px 0 8px; }
  .voice-error { flex-wrap: wrap; }
  .voice-error p { flex-basis: calc(100% - 30px); }
  .voice-error .copilotz-button { margin-left: auto; }
  .voice-failed { flex-wrap: wrap; }
  .voice-failed .copilotz-notice-body { flex-basis: calc(100% - 30px); }
  .voice-failed .copilotz-notice-action { width: 100%; justify-content: flex-end; margin: 2px 0 0; }
  .chat-keys { display: none; }
  .chat-home-body { padding: 72px 0 6vh; }
  .chat-home .chat-composer { padding: 0 14px; }
  .chat-home-body:has(.chat-notes .copilotz-notice) .chat-home-hero { transform: translateY(-48px); }
  .chat-home-top { padding: 0 14px; margin-bottom: 24px; }
  /* On a phone, the conversation or its notes, one at a time: the switch always in sight */
  .notes-toggle { display: none; }
  .notes-switch { flex: none; display: flex; gap: 4px; margin: 8px 10px 0; padding: 3px; border-radius: var(--radius-full);
    background: var(--muted); }
  .notes-switch button { flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 36px; padding: 0 12px; border: 0; border-radius: var(--radius-full); background: transparent;
    color: var(--muted-foreground); font: inherit; font-size: 13.5px; font-weight: 600; white-space: nowrap; cursor: pointer;
    transition: background-color .15s, color .15s, box-shadow .15s; }
  .notes-switch button[aria-pressed=true] { background: var(--background); color: var(--foreground); box-shadow: var(--shadow-sm); }
  .notes-switch .notes-switch-notes[aria-pressed=true] { background: var(--notes-soft); outline: 1px solid var(--notes-line); outline-offset: -1px; }
  .notes-lane { position: absolute; z-index: 6; inset: 0; width: 100%; border-left: 0; box-shadow: none; animation: none; }
  .chat-split[data-notes=open] > .chat-main { visibility: hidden; }
  .notes-head { min-height: 46px; padding: 6px 8px 6px 14px; }
  .notes-head h2 { display: none; }
  .notes-head p { color: var(--secondary-foreground); font-size: 13px; white-space: normal; }
  .notes-head .notes-mark { width: 26px; height: 26px; }
  .notes-close { display: none; }
  .notes-banner { align-items: flex-start; flex-wrap: wrap; padding: 8px 10px 8px 14px; }
  .notes-banner p { flex-basis: calc(100% - 40px); }
  .notes-banner .copilotz-button { margin-left: auto; }
  .notes-banner-only { display: block; }
  .notes-banner-only::before { content: none; }
  .chat-mention-note { flex-wrap: wrap; }
  .chat-mention-note .copilotz-notice-body { flex-basis: calc(100% - 30px); }
  .chat-mention-note .copilotz-notice-action { width: 100%; justify-content: flex-end; margin: 2px 0 0; }
}
@media (prefers-reduced-motion: reduce) {
  .notes-lane, .notes-empty, .msg-relay, .msg-relayed, .chat-mentioned { animation: none; }
}
`;
