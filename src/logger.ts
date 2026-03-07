const PREFIX = "axis-agent";

function write(level: "info" | "error", component: string, message: string): void {
  const entry = {
    app: PREFIX,
    level,
    component,
    message,
    timestamp: new Date().toISOString(),
  };
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
