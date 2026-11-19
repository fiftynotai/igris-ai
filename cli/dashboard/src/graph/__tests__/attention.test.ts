import { afterEach, describe, expect, it, vi } from "vitest";
import { fitAttentionEntry, repaintEvidence, type AttentionFitEntry } from "../attention";
import { shapeFor } from "../shapes";
import { resource } from "../../attention/__tests__/fixture";

afterEach(() => vi.useRealTimers());
describe("FR-276 evidence paint preserves the graph lifecycle", () => {
  it("wakes for a finite paint window and cleanup balances exactly once", async () => {
    vi.useFakeTimers();
    const controller = { beginInteraction: vi.fn(), endInteraction: vi.fn() };
    const stop = repaintEvidence(controller, 80);
    expect(controller.beginInteraction).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(80);
    expect(controller.endInteraction).toHaveBeenCalledOnce();
    stop(); expect(controller.endInteraction).toHaveBeenCalledOnce();
    const superseded = repaintEvidence(controller, 80); superseded();
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.beginInteraction).toHaveBeenCalledTimes(2);
    expect(controller.endInteraction).toHaveBeenCalledTimes(2);
  });
  it("explicitly maps each inventory role without changing boundary semantics", () => {
    for (const [type, shape] of Object.entries({ os_module: "STORE", context_doc: "STORE", skill: "SERVICE", agent: "AGENT", tool: "TOOL" })) {
      expect(shapeFor({ ...resource, type })).toBe(shape);
      expect(shapeFor({ ...resource, type, boundary: true })).toBe("EXTERNAL");
    }
  });
});


describe("Explicit fit entry across asynchronous topology changes", () => {
  it("fits the replacement controller after a refresh key was consumed by the old settled topology", () => {
    const old = { state: () => "still" as const, zoomToFit: vi.fn() };
    const entry: AttentionFitEntry = { controller: null, key: null };
    expect(fitAttentionEntry(old, "chat:scope:refresh1", true, entry)).toBe(true);
    let settling = true;
    const replacement = { state: () => settling ? "settling" as const : "still" as const, zoomToFit: vi.fn() };
    expect(fitAttentionEntry(replacement, "chat:scope:refresh1", true, entry)).toBe(false);
    settling = false;
    expect(fitAttentionEntry(replacement, "chat:scope:refresh1", true, entry)).toBe(true);
    for (let poll = 0; poll < 3; poll++) expect(fitAttentionEntry(replacement, "chat:scope:refresh1", true, entry)).toBe(false);
    expect(replacement.zoomToFit).toHaveBeenCalledOnce();
    expect(fitAttentionEntry(replacement, "chat:brain:refresh1", true, entry)).toBe(true);
    expect(fitAttentionEntry(replacement, null, true, entry)).toBe(false);
  });
});
