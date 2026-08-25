# Skill Action and Tool Generator

## What it is

A compiler for the progressive-disclosure Skill Actions and Tool Resources.

## Why it exists

The generated Actions share configuration and must remain paired with their
data-only Tool presentations.

## How to use it

`createSkillsPlugin` invokes it after validating the selected Skill Tool IDs.

## How it works

It generates bounded list, load, and file-read Actions plus matching Tool
Resources under stable aliases.
