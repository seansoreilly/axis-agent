import { info } from "./logger.js";
import { metrics } from "./metrics.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;
  resetTimeoutMs?: number;
  onStateChange?: (name: string, from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreakerStatus {
  name: string;
  state: CircuitState;
  failures: number;
  lastFailureAt: string | null;
}

const STATE_VALUES: Record<CircuitState, number> = {
  closed: 0,
  open: 1,
  "half-open": 2,
};

export class CircuitOpenError extends Error {
  constructor(breakerName: string) {
    super(`Circuit breaker "${breakerName}" is open`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private readonly _name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly onStateChange?: (name: string, from: CircuitState, to: CircuitState) => void;

  private _state: CircuitState = "closed";
  private failures = 0;
  private lastFailureAt: string | null = null;
  private openedAt: number | null = null;
  private probing = false;

  constructor(opts: CircuitBreakerOptions) {
    this._name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.onStateChange = opts.onStateChange;
    this.updateStateGauge();
  }

  get name(): string {
    return this._name;
  }

  get state(): CircuitState {
    // Lazy transition from open to half-open when timeout has elapsed
    if (this._state === "open" && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.transition("half-open");
      }
    }
    return this._state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state; // triggers lazy half-open check

    if (currentState === "open") {
      metrics.increment(`circuit_breaker.${this._name}.rejected`);
      throw new CircuitOpenError(this._name);
    }

    // Only allow a single probe request while half-open
    if (currentState === "half-open" && this.probing) {
      metrics.increment(`circuit_breaker.${this._name}.rejected`);
      throw new CircuitOpenError(this._name);
    }

    if (currentState === "half-open") {
      this.probing = true;
    }

    metrics.increment(`circuit_breaker.${this._name}.executions`);

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  reset(): void {
    this.failures = 0;
    this.lastFailureAt = null;
    this.openedAt = null;
    if (this._state !== "closed") {
      this.transition("closed");
    }
    info("circuit-breaker", `${this._name}: manually reset to closed`);
  }

  getStatus(): CircuitBreakerStatus {
    return {
      name: this._name,
      state: this.state,
      failures: this.failures,
      lastFailureAt: this.lastFailureAt,
    };
  }

  private onSuccess(): void {
    this.probing = false;
    if (this._state === "half-open") {
      this.transition("closed");
    }
    this.failures = 0;
  }

  private onFailure(): void {
    this.probing = false;
    this.failures++;
    this.lastFailureAt = new Date().toISOString();
    metrics.increment(`circuit_breaker.${this._name}.failures`);

    if (this._state === "half-open") {
      this.transition("open");
    } else if (this._state === "closed" && this.failures >= this.failureThreshold) {
      this.transition("open");
    }
  }

  private transition(to: CircuitState): void {
    const from = this._state;
    this._state = to;
    this.updateStateGauge();

    if (to === "open") {
      this.openedAt = Date.now();
    } else if (to === "closed") {
      this.openedAt = null;
    }

    info("circuit-breaker", `${this._name}: ${from} → ${to}`);
    this.onStateChange?.(this._name, from, to);
  }

  private updateStateGauge(): void {
    metrics.setGauge(`circuit_breaker.${this._name}.state`, STATE_VALUES[this._state]);
  }
}
