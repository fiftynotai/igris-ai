/**
 * Plain stdout logger for the Igris CLI. No emoji (per global rules).
 *
 * Verbosity model:
 *   - default: info, warn, error all print
 *   - --quiet:   only error
 *   - --verbose: info, warn, error, debug
 *
 * The verbosity is set once at CLI entry via `setVerbosity`.
 */

export type Verbosity = "quiet" | "default" | "verbose";

let verbosity: Verbosity = "default";

export function setVerbosity(v: Verbosity): void {
  verbosity = v;
}

export function getVerbosity(): Verbosity {
  return verbosity;
}

export function info(msg: string): void {
  if (verbosity !== "quiet") {
    process.stdout.write(msg + "\n");
  }
}

export function warn(msg: string): void {
  if (verbosity !== "quiet") {
    process.stderr.write("warn: " + msg + "\n");
  }
}

export function error(msg: string): void {
  process.stderr.write("error: " + msg + "\n");
}

export function debug(msg: string): void {
  if (verbosity === "verbose") {
    process.stderr.write("debug: " + msg + "\n");
  }
}
