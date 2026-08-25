# Project Tool Result Processor

## What it is

Consumes terminal Tool Action lifecycle facts for a plan stage.

## Why it exists

Tool branch advancement must be idempotent and authority-bound.

## How to use it

It is installed by Core and matches Tool lifecycle metadata.

## How it works

It validates the terminal cursor, materializes one stage receipt, and advances
only that branch.
