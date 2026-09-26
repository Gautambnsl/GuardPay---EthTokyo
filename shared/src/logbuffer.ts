/**
 * Captures this process's console output into a ring buffer so the dashboard can show a live
 * backend console. Output still goes to the terminal as usual.
 */
export interface LogLine { t: number; source: string; level: "info" | "warn" | "error"; msg: string }

const MAX = 500;
const lines: LogLine[] = [];

export function captureConsole(source: string) {
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const msg = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ");
      lines.push({ t: Date.now(), source, level: level === "log" ? "info" : level, msg });
      if (lines.length > MAX) lines.splice(0, lines.length - MAX);
    };
  }
}

export const logsSince = (t = 0) => lines.filter((l) => l.t > t);
