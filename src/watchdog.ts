import type { SqliteStore } from "./persistence.js";
import type { MetricsRegistry } from "./metrics.js";

export interface HealthCheck {
  name: string;
  severity: "warning" | "critical";
  check: () => HealthCheckResult;
}

export interface HealthCheckResult {
  healthy: boolean;
  detail: string;
}

export interface WatchdogStatus {
  status: "ok" | "degraded" | "critical";
  checks: Array<{
    name: string;
    healthy: boolean;
    detail: string;
    severity: "warning" | "critical";
    consecutiveFailures: number;
  }>;
  lastCheckAt: string | null;
}

export interface WatchdogOptions {
  checks: HealthCheck[];
  intervalMs?: number;
  alertThreshold?: number;
  onAlert?: (checkName: string, detail: string) => void;
}

export class HealthWatchdog {
  private readonly checks: HealthCheck[];
  private readonly intervalMs: number;
  private readonly alertThreshold: number;
  private readonly onAlert?: (checkName: string, detail: string) => void;

  private consecutiveFailures = new Map<string, number>();
  private lastResults = new Map<string, HealthCheckResult>();
  private lastCheckAt: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WatchdogOptions) {
    this.checks = opts.checks;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.alertThreshold = opts.alertThreshold ?? 3;
    this.onAlert = opts.onAlert;
  }

  runChecks(): void {
    for (const check of this.checks) {
      const result = check.check();
      this.lastResults.set(check.name, result);

      if (result.healthy) {
        this.consecutiveFailures.set(check.name, 0);
      } else {
        const failures = (this.consecutiveFailures.get(check.name) ?? 0) + 1;
        this.consecutiveFailures.set(check.name, failures);

        if (failures === this.alertThreshold && this.onAlert) {
          this.onAlert(check.name, result.detail);
        }
      }
    }
    this.lastCheckAt = new Date().toISOString();
  }

  getStatus(): WatchdogStatus {
    let status: "ok" | "degraded" | "critical" = "ok";

    const checks = this.checks.map((check) => {
      const result = this.lastResults.get(check.name);
      const healthy = result?.healthy ?? true;
      const detail = result?.detail ?? "not yet checked";
      const failures = this.consecutiveFailures.get(check.name) ?? 0;

      if (!healthy) {
        if (check.severity === "critical") {
          status = "critical";
        } else if (status !== "critical") {
          status = "degraded";
        }
      }

      return {
        name: check.name,
        healthy,
        detail,
        severity: check.severity,
        consecutiveFailures: failures,
      };
    });

    return { status, checks, lastCheckAt: this.lastCheckAt };
  }

  start(): void {
    this.runChecks();
    this.timer = setInterval(() => this.runChecks(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// --- Factory functions ---

export function memoryCheck(maxHeapMb: number): HealthCheck {
  return {
    name: "memory",
    severity: "warning",
    check: (): HealthCheckResult => {
      const heapUsed = process.memoryUsage().heapUsed;
      const heapMb = Math.round(heapUsed / 1024 / 1024);
      const healthy = heapMb <= maxHeapMb;
      return {
        healthy,
        detail: `Heap: ${heapMb} MB / ${maxHeapMb} MB`,
      };
    },
  };
}

export function jobQueueCheck(store: SqliteStore): HealthCheck {
  return {
    name: "job_queue",
    severity: "critical",
    check: (): HealthCheckResult => {
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const stuck = store.getStuckJobs(cutoff);
      const healthy = stuck.length === 0;
      return {
        healthy,
        detail: healthy ? "No stuck jobs" : `${stuck.length} stuck job(s)`,
      };
    },
  };
}

export function errorRateCheck(metricsRegistry: MetricsRegistry, threshold: number): HealthCheck {
  return {
    name: "error_rate",
    severity: "warning",
    check: (): HealthCheckResult => {
      const snap = metricsRegistry.snapshot();
      const errors = snap.counters["agent.errors"] ?? 0;
      const requests = snap.counters["agent.requests"] ?? 0;
      if (requests === 0) {
        return { healthy: true, detail: "No requests yet" };
      }
      const rate = errors / requests;
      const pct = Math.round(rate * 100);
      const healthy = rate <= threshold;
      return {
        healthy,
        detail: `Error rate: ${pct}% (${errors}/${requests}), threshold: ${Math.round(threshold * 100)}%`,
      };
    },
  };
}
