# MiniMax adapter

## What it is

The built-in MiniMax provider wire adapter.

## Why it exists

It translates MiniMax’s Anthropic-compatible protocol into the LLM boundary.

## How to use it

Declare a Model Resource with `provider: "minimax"`.

## How it works

It builds multimodal Messages API requests and normalizes resulting frames.
