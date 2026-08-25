# Run Command Action

## What it is

The executable Action that runs one bounded Deno subprocess command.

## Why it exists

It gives agents process access with dangerous-command, timeout, and cancellation
controls.

## How to use it

Compose it through `createProcessToolsPlugin()` using the `run_command` alias.

## How it works

The Action validates the command and working directory, then drains stdout and
stderr while terminating the child on timeout or cancellation.
