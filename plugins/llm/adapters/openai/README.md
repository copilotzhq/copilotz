# OpenAI adapter

## What it is

The built-in OpenAI provider wire adapter.

## Why it exists

It translates the provider protocol into Copilotz’s provider-neutral LLM
boundary.

## How to use it

Declare a Model Resource with `provider: "openai"`.

## How it works

It selects the configured OpenAI API mode and decodes its streaming response.
