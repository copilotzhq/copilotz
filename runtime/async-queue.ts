/** A small Web Streams-backed async multicast primitive. */

export interface StreamSubscription<T> {
  readonly stream: ReadableStream<T>;
  close(reason?: unknown): void;
}

interface Subscriber<T> {
  controller: ReadableStreamDefaultController<T>;
  closed: boolean;
  filter?: (value: T) => boolean;
}

export class AsyncBroadcast<T> {
  #subscribers = new Set<Subscriber<T>>();
  #closed = false;
  #error: unknown;

  subscribe(filter?: (value: T) => boolean): StreamSubscription<T> {
    if (this.#closed) {
      return {
        stream: new ReadableStream<T>({
          start: (controller) => {
            if (this.#error !== undefined) controller.error(this.#error);
            else controller.close();
          },
        }),
        close() {},
      };
    }

    let subscriber: Subscriber<T> | undefined;
    const stream = new ReadableStream<T>({
      start: (controller) => {
        subscriber = { controller, closed: false, filter };
        this.#subscribers.add(subscriber);
      },
      cancel: () => {
        if (!subscriber) return;
        subscriber.closed = true;
        this.#subscribers.delete(subscriber);
      },
    });

    return {
      stream,
      close: (reason?: unknown) => {
        if (!subscriber || subscriber.closed) return;
        subscriber.closed = true;
        this.#subscribers.delete(subscriber);
        if (reason !== undefined) subscriber.controller.error(reason);
        else subscriber.controller.close();
      },
    };
  }

  publish(value: T): void {
    if (this.#closed) return;
    for (const subscriber of [...this.#subscribers]) {
      if (subscriber.closed) continue;
      try {
        if (!subscriber.filter || subscriber.filter(value)) {
          subscriber.controller.enqueue(value);
        }
      } catch (error) {
        subscriber.closed = true;
        this.#subscribers.delete(subscriber);
        subscriber.controller.error(error);
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.closed = true;
      subscriber.controller.close();
    }
    this.#subscribers.clear();
  }

  error(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const subscriber of this.#subscribers) {
      subscriber.closed = true;
      subscriber.controller.error(error);
    }
    this.#subscribers.clear();
  }
}
