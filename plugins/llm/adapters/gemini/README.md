# Gemini adapter

## What it is

The built-in Gemini provider wire adapter.

## Why it exists

It translates Gemini requests and stream frames into the LLM boundary.

## How to use it

Declare a Model Resource with `provider: "gemini"`.

## How it works

It formats Gemini contents, applies protocol limits, and normalizes output.
