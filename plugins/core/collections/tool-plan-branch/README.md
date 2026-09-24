# Tool Plan Branch Collection

## What it is

One durable cursor for one provider Tool-plan branch.

## Why it exists

Sibling pipelines need independent writes so one branch can settle without
rewriting another branch's state.

## How to use it

Core's Tool-plan coordinator owns these records. Applications should use the
parent `toolPlan` record for diagnostics and should not mutate branch state.

## How it works

Each branch claims and advances its own Tool stages. The parent plan opens one
ordered projection barrier after every branch has settled.
