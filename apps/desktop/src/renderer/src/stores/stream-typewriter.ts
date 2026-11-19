/**
 * Types a streamed reply out at a natural pace. The model's tokens arrive in bursts (Gemini sends tens of tokens
 * per chunk, so a 1-3 sentence answer can be a single chunk and appeared all at once); this keeps a small buffer
 * and reveals it frame by frame: fast when a lot is waiting, never slower than a reader's pace. With "reduce
 * motion" every chunk shows as soon as it arrives.
 */

export interface TypewriterOptions {
  /** Shows the text revealed so far. */
  render: (text: string) => void;
  reduceMotion?: () => boolean;
  /** Injected for tests; requestAnimationFrame in the app. */
  schedule?: (cb: (time: number) => void) => number;
  cancel?: (handle: number) => void;
}

/** Characters per second: drain what is waiting in about half a second, within these bounds. */
const MIN_RATE = 45;
const MAX_RATE = 600;
const DRAIN_SECONDS = 0.5;

export class Typewriter {
  private target = '';
  private shown = 0;
  private carry = 0;
  private handle = 0;
  private last = 0;
  private onDone: (() => void) | null = null;

  constructor(private readonly opts: TypewriterOptions) {}

  /** More text from the stream. */
  push(delta: string): void {
    this.target += delta;
    if (this.opts.reduceMotion?.()) {
      this.shown = this.target.length;
      this.opts.render(this.target);
      return;
    }
    this.start();
  }

  /** The stream ended: call `done` once everything has been typed out. */
  finish(done: () => void): void {
    this.onDone = done;
    if (this.shown >= this.target.length) this.complete();
    else this.start();
  }

  /** Shows everything at once and completes (a new reply started before this one finished typing). */
  flush(): void {
    if (this.handle) (this.opts.cancel ?? cancelAnimationFrame)(this.handle);
    this.handle = 0;
    if (this.shown < this.target.length) {
      this.shown = this.target.length;
      this.opts.render(this.target);
    }
    this.complete();
  }

  /** Stops without calling `done` (the chat changed). */
  stop(): void {
    if (this.handle) (this.opts.cancel ?? cancelAnimationFrame)(this.handle);
    this.handle = 0;
    this.onDone = null;
  }

  get typing(): boolean {
    return this.shown < this.target.length;
  }

  private start(): void {
    if (this.handle) return;
    this.last = 0;
    this.handle = (this.opts.schedule ?? requestAnimationFrame)(this.tick);
  }

  private tick = (time: number): void => {
    this.handle = 0;
    const dt = this.last ? Math.min(100, time - this.last) : 16;
    this.last = time;
    const backlog = this.target.length - this.shown;
    const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, backlog / DRAIN_SECONDS));
    this.carry += (rate * dt) / 1000;
    let n = Math.floor(this.carry);
    this.carry -= n;
    if (n > 0) {
      // Never stop between the two halves of an emoji or other surrogate pair.
      let next = Math.min(this.target.length, this.shown + n);
      const code = this.target.charCodeAt(next - 1);
      if (code >= 0xd800 && code <= 0xdbff && next < this.target.length) next++;
      n = next - this.shown;
      this.shown = next;
      this.opts.render(this.target.slice(0, this.shown));
    }
    if (this.shown < this.target.length) this.handle = (this.opts.schedule ?? requestAnimationFrame)(this.tick);
    else this.complete();
  };

  private complete(): void {
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }
}
