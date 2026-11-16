import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionSnapshot } from "../../lib/api";
import { startAttentionPoll } from "../poll";
import { SESSION_A, SESSION_B, session, snapshot } from "./fixture";

function deferred() {
  let resolve!: (value: AttentionSnapshot) => void;
  const promise = new Promise<AttentionSnapshot>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
describe("FR-276 session poll isolation", () => {
  it("rejects wrong-session responses and disposed requests even if transport ignores abort", async () => {
    const pending = deferred();
    const accept = vi.fn(); const reject = vi.fn();
    const options = { sessionId: SESSION_A, replay: false, read: () => pending.promise, accept, reject, hidden: () => false, subscribe: () => () => undefined, intervalMs: 5_000 };
    const loop = startAttentionPoll(options);
    pending.resolve(snapshot({ session: session({ id: SESSION_B }) }));
    await Promise.resolve();
    expect(accept).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(expect.stringContaining("identity mismatch"));
    loop.stop();
    const stale = deferred();
    const old = startAttentionPoll({ ...options, read: () => stale.promise });
    old.stop(); stale.resolve(snapshot()); await Promise.resolve();
    expect(accept).not.toHaveBeenCalled();
  });
  it("pauses reads while hidden, refreshes on return, and advances only live recordings", async () => {
    vi.useFakeTimers();
    let hidden = true; let visibility: () => void = () => undefined;
    const read = vi.fn(async () => snapshot());
    const accept = vi.fn();
    const unsubscribe = vi.fn();
    const options = { sessionId: SESSION_A, replay: false, read, accept, reject: vi.fn(), hidden: () => hidden, subscribe: (listener: () => void) => { visibility = listener; return unsubscribe; }, intervalMs: 5_000 };
    const loop = startAttentionPoll(options);
    await vi.advanceTimersByTimeAsync(10_000); expect(read).not.toHaveBeenCalled();
    hidden = false; visibility(); await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000); expect(read).toHaveBeenCalledTimes(2);
    hidden = true; visibility(); await vi.advanceTimersByTimeAsync(10_000); expect(read).toHaveBeenCalledTimes(2);
    loop.stop(); expect(unsubscribe).toHaveBeenCalledOnce();
    hidden = false;
    const replay = startAttentionPoll({ ...options, replay: true });
    await vi.advanceTimersByTimeAsync(20_000); expect(read).toHaveBeenCalledTimes(3);
    replay.stop(); expect(accept).toHaveBeenCalledTimes(3);
  });
  it("does not publish a superseded poll from the same session", async () => {
    const first = deferred(); const second = deferred(); const accept = vi.fn();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const loop = startAttentionPoll({ sessionId: SESSION_A, replay: false, read, accept, reject: vi.fn(), hidden: () => false, subscribe: () => () => undefined, intervalMs: 5_000 });
    loop.refresh(); second.resolve(snapshot({ through_sequence: 2 })); await Promise.resolve();
    first.resolve(snapshot()); await Promise.resolve();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]?.[0].through_sequence).toBe(2);
    loop.stop();
  });
});
