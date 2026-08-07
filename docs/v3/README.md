---
title: Copilotz v3 Design Gate
description: Review artifacts that must be accepted before the v3 refactor starts.
section: Internal Design
status: proposal
---

# Copilotz v3 Design Gate

This directory records the design contract for a fresh v3 implementation. It is
not current user documentation and is intentionally excluded from
`docs/manifest.json` until the design is accepted and implemented.

The baseline is `origin/main` at commit `64dddb8` (`0.56.1`) on 2026-08-06. The
existing `v3` branch is an architectural spike and evidence source, not the
implementation baseline. In particular, it deleted most current capabilities,
documentation, and tests and introduced stateful service classes. Those choices
must not be carried forward implicitly.

## Review Artifacts

- [Feature and Test Parity Ledger](./feature-test-parity.md) defines what must
  remain observable, which architecture-coupled tests need replacement, which
  missing characterization tests must be added first, and which downstream apps
  form the compatibility gate.
- [Content and Asset Model](./content-assets.md) defines a shared representation
  for text, structured values, files, tool payloads, finalized realtime media,
  and future modalities while keeping routing metadata inline and raw stream
  frames ephemeral.

## Non-Negotiable Constraints

1. The implementation starts from current `main`, not from the v3 spike.
2. Runtime modules use factories, closures, functions, and plain records.
   Stateful service classes are not part of the architecture. Narrow error
   subclasses may remain where JavaScript error identity is useful.
3. Product behavior is not removed merely because its current implementation is
   queue-specific, Deno-specific, or otherwise due for replacement.
4. Every removed test has a named parity replacement that passes first.
5. Direct downstream consumers are tested before a breaking API is accepted.
6. Durable semantic state and guaranteed work are database-backed. Oxian owns
   execution placement and transport, not Copilotz domain state.
7. Raw audio, token, and future video frames are stream data, not database
   events. Durable outcomes use the same content/asset model as text.

## Start Gate

Implementation can begin only after these artifacts are reviewed and the P0
characterization tests in the parity ledger are present on `main`. Design
changes discovered later update these documents and their corresponding tests
before old behavior is deleted.
