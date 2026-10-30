/** A chat that isn't there, or isn't yours to see: said plainly, with a way on. */
import type { ReactNode } from "react";
import { Button, EmptyState, Title } from "../../../../../hosts/web/mod.ts";

export function Missing({ fresh }: { fresh: string }): ReactNode {
  return (
    <section className="chat chat-missing" aria-labelledby="chat-missing-title">
      <Title text="Not found" />
      <EmptyState
        icon="lock"
        heading="h1"
        id="chat-missing-title"
        title="This chat isn't here"
        action={
          <Button variant="primary" icon="compose" href={fresh}>
            Start a new chat
          </Button>
        }
      >
        It may have moved, or it isn't shared with you. Someone in it can invite you to its space.
      </EmptyState>
    </section>
  );
}
