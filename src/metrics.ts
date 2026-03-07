export interface MetricSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      gauges: Object.fromEntries(this.gauges.entries()),
    };
  }
}

export const metrics = new MetricsRegistry();
