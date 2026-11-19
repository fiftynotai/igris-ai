import type { AttentionLens } from "./lens";

export function AttentionLensControls({ lens, neighbours, recordedCount, neighbourCount, onLens, onNeighbours }: {
  lens: AttentionLens; neighbours: boolean; recordedCount: number; neighbourCount: number;
  onLens: (lens: AttentionLens) => void; onNeighbours: (include: boolean) => void;
}) {
  return <div className="attention-lens" data-attention-lens={lens}>
    <div className="attention-actions" role="group" aria-label="Map view">
      <button type="button" className="graph-control" aria-pressed={lens === "chat"} onClick={() => onLens("chat")}>This chat</button>
      <button type="button" className="graph-control" aria-pressed={lens === "brain"} onClick={() => onLens("brain")}>Whole brain</button>
      {lens === "chat" && <button type="button" className="graph-control" aria-pressed={neighbours} onClick={() => onNeighbours(!neighbours)}>Show related nodes</button>}
    </div>
    {lens === "chat" && <p>{recordedCount} recorded nodes{neighbours ? ` + ${neighbourCount} related nodes` : ""}. Related nodes show knowledge relationships; they carry no session activity unless recorded.</p>}
  </div>;
}
