import type { AttentionNodeState } from "../lib/api";
import { EVIDENCE } from "../attention/model";
import type { GraphController } from "./instance";
import type { DatavizPalette } from "./palette";
import { nodeWorldSize } from "./shapes";

/** Evidence is a badge beside the role silhouette; selection keeps its ring. */
export function paintEvidence(ctx: CanvasRenderingContext2D, state: AttentionNodeState, x: number, y: number, sizePx: number, scale: number, palette: DatavizPalette, font: (size: number) => string): void {
  const size = nodeWorldSize(Math.max(8, sizePx * 0.65), scale);
  const offset = nodeWorldSize(sizePx, scale) * 0.65;
  ctx.save();
  ctx.fillStyle = state.state === "historical" || state.state === "available" ? palette.muted : palette.accent;
  ctx.font = font(size);
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${EVIDENCE[state.state].mark}${state.self_reported ? "S" : ""}`, x + offset, y - offset);
  ctx.restore();
}

/** One finite repaint, with balanced cleanup even when a new poll supersedes it. */
export function repaintEvidence(controller: Pick<GraphController, "beginInteraction" | "endInteraction">, duration: number): () => void {
  controller.beginInteraction();
  let finished = false;
  const finish = (): void => { if (!finished) { finished = true; controller.endInteraction(); } };
  const timer = setTimeout(finish, duration);
  return () => { clearTimeout(timer); finish(); };
}

export interface AttentionFitEntry {
  controller: Pick<GraphController, "state" | "zoomToFit"> | null;
  key: string | null;
}
/** A requested scope can precede its topology. Each new controller still gets its own fit. */
export function fitAttentionEntry(controller: Pick<GraphController, "state" | "zoomToFit">, key: string | null, settled: boolean, previous: AttentionFitEntry): boolean {
  if (!settled || key === null || controller.state() === "settling") return false;
  if (previous.controller === controller && previous.key === key) return false;
  previous.controller = controller; previous.key = key;
  controller.zoomToFit();
  return true;
}
