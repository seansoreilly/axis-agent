const PREFIX = "axis-agent";

export interface BoundLogger {
  info: (component: string, message: string) => void;
  error: (component: string, message: string) => void;
}

function write(level: "info" | "error", component: string, message: string, correlationId?: string): void {
  const entry: Record<string, string> = {
    app: PREFIX,
    level,
    component,
    message,
    timestamp: new Date().toISOString(),
  };
  if (correlationId) {
    entry.correlationId = correlationId;
  }
  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export function info(component: string, message: string): void {
  write("info", component, message);
}

export function error(component: string, message: string): void {
  write("error", component, message);
}

export function createLogger(correlationId?: string): BoundLogger {
  return {
    info: (component: string, message: string): void => write("info", component, message, correlationId),
    error: (component: string, message: string): void => write("error", component, message, correlationId),
  };
}
