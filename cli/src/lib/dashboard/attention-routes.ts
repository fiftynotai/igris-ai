/** Pure attention routes: validation at HTTP boundary, builders behind readonly door. */
import { attentionInventory, attentionSessions, attentionSnapshot } from "../attention-bridge.js";
import { ATTENTION_UUID, attentionInteger } from "../../verbs/attention.js";
export async function attentionRoute(path: string, params: URLSearchParams): Promise<{
  status: number;
  body: unknown;
}> {
  try {
    const project = params.get("project") ?? undefined;
    if (project !== undefined && !/^[a-zA-Z0-9_-]+$/.test(project))
      throw new Error("invalid project slug");
    const limit = attentionInteger(params.get("limit") ?? undefined, 1, 100);
    if (path === "/api/attention/inventory")
      return { status: 200, body: await attentionInventory(project) };
    if (path === "/api/attention/sessions") {
      const before = params.get("before") ?? undefined;
      if (before !== undefined) {
        if (!ATTENTION_UUID.test(before))
          throw new Error("sessions cursor must be a UUID");
        const cursor = await attentionSnapshot({ session_id: before });
        if (cursor.session === null && cursor.degraded === null)
          throw new Error("unknown sessions cursor");
      }
      return { status: 200, body: await attentionSessions({ project, before, limit }) };
    }
    const session = params.get("session");
    if (!session || !ATTENTION_UUID.test(session))
      throw new Error("session must be a UUID");
    const through = attentionInteger(params.get("through") ?? undefined, 0), before = attentionInteger(params.get("before") ?? undefined, 1);
    const body = await attentionSnapshot({ session_id: session, through_sequence: through, before, limit });
    return { status: body.session === null && body.degraded === null ? 404 : 200, body };
  }
  catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
