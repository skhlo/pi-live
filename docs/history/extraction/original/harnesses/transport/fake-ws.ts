export type FakeListener = (...args: unknown[]) => void;

export const fakeSockets: FakeWebSocket[] = [];

export default class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, FakeListener[]>();

  constructor(_url: string, _options: unknown) {
    fakeSockets.push(this);
  }

  on(event: string, listener: FakeListener): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: FakeListener): this {
    const onceListener: FakeListener = (...args) => {
      const listeners = this.#listeners.get(event);
      if (listeners) this.#listeners.set(event, listeners.filter((candidate) => candidate !== onceListener));
      listener(...args);
    };
    return this.on(event, onceListener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  terminate(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}
