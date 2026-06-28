import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import type { InstanceLivenessStatus, InstanceRow } from "../types.js";

export interface OwnerProcess {
  pid: number;
  started_at: string;
}

export interface InstanceLiveness {
  status: InstanceLivenessStatus;
  checked_at: string;
  method: string;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function getProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

export function resolveOwnerProcess(
  env: NodeJS.ProcessEnv = process.env,
): OwnerProcess | null {
  const explicit = parsePositiveInt(env.IGRIS_INSTANCE_OWNER_PID);
  const pid = explicit ?? process.ppid;
  const startedAt = getProcessStartTime(pid);
  return startedAt ? { pid, started_at: startedAt } : null;
}

export function classifyInstanceLiveness(
  row: InstanceRow,
  localHostname = hostname(),
): InstanceLiveness {
  const checkedAt = new Date().toISOString().replace("T", " ").substring(0, 19);

  if (row.machine_hostname !== localHostname) {
    return {
      status: "unknown_remote",
      checked_at: checkedAt,
      method: "remote",
    };
  }

  if (
    typeof row.owner_pid !== "number" ||
    !Number.isInteger(row.owner_pid) ||
    row.owner_pid <= 0 ||
    row.owner_started_at === null ||
    row.owner_started_at === undefined
  ) {
    return {
      status: "unknown_no_metadata",
      checked_at: checkedAt,
      method: "none",
    };
  }

  if (!isProcessAlive(row.owner_pid)) {
    return {
      status: "dead",
      checked_at: checkedAt,
      method: "pid_start_time",
    };
  }

  const currentStartedAt = getProcessStartTime(row.owner_pid);
  if (currentStartedAt === null || currentStartedAt !== row.owner_started_at) {
    return {
      status: "dead_pid_reused",
      checked_at: checkedAt,
      method: "pid_start_time",
    };
  }

  return {
    status: "alive",
    checked_at: checkedAt,
    method: "pid_start_time",
  };
}
