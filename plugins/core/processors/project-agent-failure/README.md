# Project Agent Failure Processor

## What it is

The Core projection from a terminal ordinary `llm.call` failure or cancellation
to one public Agent failure Message.

## Why it exists

An exhausted Model fallback must leave a deterministic, user-visible terminal
fact instead of making a conversation appear to hang.

## How to use it

Include the standard Core plugin. The processor subscribes to ordinary public
`llm.call.failed` and `llm.call.cancelled` lifecycle events automatically; it
requires no application configuration and exposes no provider diagnostics.

## How it works

The processor derives its Message id from the LLM Action run, making retries
idempotent. It writes only safe causal metadata and a fixed user-facing text;
raw provider errors never become Message content or metadata. Ask, delegated,
and private Agent turns are intentionally excluded. Failure Messages are never
included in later LLM transcripts.
