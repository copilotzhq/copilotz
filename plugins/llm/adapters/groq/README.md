# Groq adapter

## What it is

The built-in Groq provider wire adapter.

## Why it exists

It translates Groq’s OpenAI-compatible protocol into the LLM boundary.

## How to use it

Declare a Model Resource with `provider: "groq"`.

## How it works

It sends compatible chat requests and normalizes stream deltas and finish
reasons.
