// TD-525 fixture (ER1-ER3): an --import preload for the brain under test. A 1 ms main-thread
// ticker records the most main-thread CPU spent between two of its turns (test_standards, BR-121).
// On SIGUSR2 it appends one JSON line to $TD525_TICKER_OUT and starts a new window. It also counts
// the PARENT's own `Pipeline loaded` lines (R9): the embed child writes to fd 2 directly, so its
// line never passes through this process's process.stderr.write.
import { appendFileSync } from 'node:fs';

const out = process.env.TD525_TICKER_OUT;
const cpu = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1e3;
};
let last = cpu();
let maxGap = 0;
let ticks = 0;
let parentLoads = 0;
const tick = () => {
  const now = cpu();
  maxGap = Math.max(maxGap, now - last);
  last = now;
  ticks++;
  setTimeout(tick, 1).unref();
};
setTimeout(tick, 1).unref();

const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (String(chunk).includes('Pipeline loaded')) parentLoads++;
  return write(chunk, ...rest);
};

process.on('SIGUSR2', () => {
  if (out) appendFileSync(out, JSON.stringify({ maxGapCpuMs: maxGap, ticks, parentLoads }) + '\n');
  maxGap = 0;
  ticks = 0;
  last = cpu();
});
