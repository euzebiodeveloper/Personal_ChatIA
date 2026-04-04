import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE = path.join(app.getPath('userData'), 'assistant.log');
const MAX_BYTES = 2 * 1024 * 1024; // rotate after 2 MB

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: string, msg: string): void {
  const line = `[${timestamp()}] [${level}] ${msg}\n`;

  // Rotate if too big
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch { /* file doesn't exist yet — fine */ }

  fs.appendFileSync(LOG_FILE, line, 'utf8');
  // Mirror to stdout so DevTools console still works
  process.stdout.write(line);
}

export const logger = {
  info: (msg: string) => write('INFO ', msg),
  warn: (msg: string) => write('WARN ', msg),
  error: (msg: string, err?: unknown) => {
    const detail = err instanceof Error
      ? `${err.message}\n  stack: ${err.stack ?? '(no stack)'}`
      : err !== undefined ? String(err) : '';
    write('ERROR', detail ? `${msg} — ${detail}` : msg);
  },
  path: () => LOG_FILE,
};
