export interface PercentileResult {
  p50: number;
  p95: number;
  p99: number;
}

export interface HistogramSnapshot extends PercentileResult {
  count: number;
}

export interface MetricSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
}

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  histogram(name: string, value: number): void {
    const values = this.histograms.get(name) ?? [];
    values.push(value);
    this.histograms.set(name, values);
  }

  percentiles(name: string): PercentileResult {
    const values = this.histograms.get(name);
    if (!values?.length) {
      return { p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    };
  }

  snapshot(): MetricSnapshot {
    const histogramEntries: Record<string, HistogramSnapshot> = {};
    for (const [name, values] of this.histograms.entries()) {
      const p = this.percentiles(name);
      histogramEntries[name] = { ...p, count: values.length };
    }
    return {
      counters: Object.fromEntries(this.counters.entries()),
      gauges: Object.fromEntries(this.gauges.entries()),
      histograms: histogramEntries,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export const metrics = new MetricsRegistry();
