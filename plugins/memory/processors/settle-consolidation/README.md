# Settle consolidation

## what it is

The detached recovery processor for Memory-owned scoped Agent turns.

## why it exists

Core intentionally does not understand Memory checkpoints, while pending
checkpoints still need explicit failed and cancelled terminal states.

## how to use it

It is composed automatically by `createLongTermMemoryPlugin` when Memory is
enabled.

## how it works

It verifies the generic turn against Memory-owned task metadata, settles LLM
failure or cancellation, and sends one scoped repair after a final answer that
omits `consolidate_memory`; a second omission fails the checkpoint.
