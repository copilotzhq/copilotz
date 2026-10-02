# Prerecorded transcription

Optional plugin: import `transcriptionPlugin` from
`@copilotz/copilotz/transcription` and register it through the ordinary plugin
configuration. It exposes `transcribeAudio({ assetId, connection })` and returns
`{ text, sourceAssetId, model }`.

Configure `resources.transcription.<connection>` with `provider` (`openai` or
`gemini`), an actual transcription `model`, optional `maxBytes` (up to 25 MB),
`timeoutMs` (up to 120 seconds), and optional `languageCodes`. Configure
`adapters.transcription.<connection>.resolveApiKey` as a host-owned asynchronous
credential resolver. Never put credentials in Action inputs or conversation
text.

The host supplies its existing content get/open/authorize services. The
operation bounds source acquisition, credentials and provider work under one
cancellation and timeout scope. Original recordings are not rewritten. Provider
responses are limited to 1 MB; provider response bodies are excluded from
errors.

The transcript is ordinary conversation text, not a source-dependent asset. The
application adds it to the originating user message as labelled verbatim text
through its existing message/content primitives, preserving sender and
mixed-content order. The Action itself does not create or impersonate a message.
Once stored in history, the text follows normal conversation access and
retention; deleting the recording alone does not erase the transcript. Durable
Action replay uses normal Action semantics. No new authorization declaration or
migration.
