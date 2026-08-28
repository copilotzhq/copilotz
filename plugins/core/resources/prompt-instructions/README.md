# Prompt Instruction Resource

## What it is

A static, trusted application-policy contribution to every Core agent prompt.

## Why it exists

Applications often have shared operating instructions that apply to all Agents.
They are different from `promptContext`, whose content is deliberately rendered
as untrusted context or evidence.

## How to use it

Create one with `definePromptInstructionResource` and register it under
`resources.promptInstructions`.

## How it works

Core orders contributions by their stable resource id and renders them before
the selected Agent's own instructions. The Resource contains static text only;
an application may load a local file at build time, but Core never discovers or
reads files implicitly.

The resolved prompt is durably recorded in the subsequent `llm.call` input for
reproducibility. Do not put credentials, secrets, tenant data, user input, or
other untrusted text in a Prompt Instruction Resource.
