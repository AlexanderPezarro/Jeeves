export interface PhoneResult {
  ok: boolean;
  error?: string;
  device_id?: number;
}

export const PHONE_TIMEOUT_MS = 60_000;

/** Workflow steps waiting for the phone to report back, keyed by phone command id. */
export class PhoneCommands {
  private readonly waiters = new Map<number, { resolve: (r: PhoneResult | "timeout") => void; timer: NodeJS.Timeout }>();

  constructor(readonly timeoutMs = PHONE_TIMEOUT_MS) {}

  /** Resolves with the phone's result, or "timeout". Registers synchronously. */
  wait(id: number): Promise<PhoneResult | "timeout"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve("timeout");
      }, this.timeoutMs);
      this.waiters.set(id, { resolve, timer });
    });
  }

  /** Delivers a result to the waiting step. False if nothing is waiting (late reply, restart). */
  settle(id: number, result: PhoneResult): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(result);
    return true;
  }

  /** Drops a waiter without resolving it (the caller no longer awaits it). */
  cancel(id: number): void {
    const w = this.waiters.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(id);
  }
}
