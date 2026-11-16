import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionPanel } from "../AttentionPanel";
import { AttentionInspector } from "../AttentionInspector";
import { event, resource, SESSION_A, session, snapshot, state } from "./fixture";

describe("FR-276 evidence rendered without invented certainty", () => {
  it("shows a failed attempt alongside full delivery with provenance and self-report", () => {
    const html = renderToStaticMarkup(<AttentionInspector offMap state={state({ self_reported: true, events: [event(), event({ id: 2, sequence: 2, outcome: "failed", extent: "unknown", origin: "self_report", reason: "unreadable" })] })} />);
    for (const text of ["Full delivered", "delivery failed", "SELF-REPORTED", "root", "sha256:fixture", "42", "2026-10-19T10:00:00.000Z", "Outside this map", "unreadable"]) expect(html).toContain(text);
  });
  it("shows completed recordings, unknown binding/compaction, coverage gaps and replay", () => {
    const html = renderToStaticMarkup(<AttentionPanel sessionId={SESSION_A} snapshot={snapshot({ session: session({ status: "ended", ended_at: "2026-10-19T11:00:00.000Z" }) })}
      error={null} loading={false} inventory={null} inventoryError="missing inventory" selectedKey={resource.key} offMap={[]} sessions={null} through={1} before={null}
      onReplay={() => undefined} onPage={() => undefined} onSelect={() => undefined} onRefresh={() => undefined} />);
    for (const text of ["ended", "unknown — no verified chat identity", "compaction unknown", "external tools unobserved", "REPLAY THROUGH 1", "RETURN TO LIVE", "missing inventory", "retention"]) expect(html).toContain(text);
    expect(html).toContain('data-attention-session="' + SESSION_A + '"');
  });
  it("distinguishes no recording, missing schema, and unavailable server", () => {
    const base = { inventory: null, inventoryError: null, selectedKey: null, offMap: [], sessions: null, through: null, before: null, onReplay: () => undefined, onPage: () => undefined, onSelect: () => undefined, onRefresh: () => undefined };
    expect(renderToStaticMarkup(<AttentionPanel {...base} sessionId={null} snapshot={null} loading={false} error={null} />)).toContain("Choose a recording");
    expect(renderToStaticMarkup(<AttentionPanel {...base} sessionId={SESSION_A} snapshot={snapshot({ session: null, degraded: { reason: "schema missing" } })} loading={false} error={null} />)).toContain("schema missing");
    expect(renderToStaticMarkup(<AttentionPanel {...base} sessionId={SESSION_A} snapshot={null} loading={false} error="offline" />)).toContain("Activity unavailable — offline");
  });
});


describe("Selection explanations remain distinct from delivery evidence", () => {
  it("renders caller declarations and observed retrieval with different provenance", () => {
    const observed = event({ id: 3, sequence: 3, selection: { category: "retrieval", provenance: "observed", reference: "igris_memory_recall" } });
    const declared = event({ selection: { category: "boot", provenance: "caller_declared", reference: "boot" } });
    const html = renderToStaticMarkup(<AttentionInspector offMap={false} state={state({ last_event: observed, events: [declared, observed] })} />);
    for (const text of ["Why selected", "Boot rules", "Reported by agent", "Observed retrieval", "Full delivered", "igris_memory_recall"]) expect(html).toContain(text);
    expect(html).toContain('data-selection-provenance="observed"');
    expect(html).toContain('data-selection-provenance="caller_declared"');
  });
  it("does not infer a reason from legacy evidence or from the failure detail", () => {
    const old = event({ selection: null, reason: "boot read failed", outcome: "failed" });
    const html = renderToStaticMarkup(<AttentionInspector offMap={false} state={state({ last_event: old, events: [old, event()] })} />);
    expect(html.match(/Not recorded/g)).toHaveLength(3);
    expect(html).toContain("Event detail: boot read failed");
    expect(html).not.toContain("Boot rules");
  });
  it("explains an unrecorded semantic neighbour without claiming it was delivered", () => {
    const html = renderToStaticMarkup(<AttentionInspector offMap={false} state={null} neighbour={{ node: resource, relations: [{ id: "link", from: "a", to: resource.key, source_edge_id: 1, type: "derived_from", provenance: "inferred", confidence: 0.5, resolution: "unique" }] }} />);
    expect(html).toContain("No activity recorded"); expect(html).toContain("derived from"); expect(html).toContain("inferred");
    expect(html).not.toContain("Full delivered");
  });
});
