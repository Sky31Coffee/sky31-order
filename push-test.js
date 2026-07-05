import { withD1Store } from "../_d1-kv.js";
import { webPushStatus } from "../_push.js";

export async function onRequestGet(context) {
  const env = withD1Store(context.env);
  const status = webPushStatus(env);
  return new Response(JSON.stringify({ ok: true, webPush: status }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
