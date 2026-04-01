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

