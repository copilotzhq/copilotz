# Skills

## What it is

A plugin for immutable Open Agent Skill Resources and progressive-disclosure
Tools.

## Why it exists

Agents need portable instructions and related files without placing every Skill
body in every model prompt.

## How to use it

Define Skills, compose `createSkillsPlugin({ skills })`, and grant Skill names
to Agents.

## How it works

Skill Resources lazily expose validated files. Authoring helpers generate the
list, load, and read Actions/Tool Resources and can build portable modules from
filesystem Skill directories.
