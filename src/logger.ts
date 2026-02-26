const PREFIX = "[claude-agent]";

export function info(component: string, message: string): void {
  process.stdout.write(`${PREFIX} [${component}] ${message}\n`);
}

export function error(component: string, message: string): void {
  process.stderr.write(`${PREFIX} [${component}] ERROR: ${message}\n`);
}
