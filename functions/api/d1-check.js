import { withD1Store, sky31D1Status } from "../_d1-kv.js";

export async function onRequestGet(context) {
  const status = sky31D1Status(context.env);
  if (!status.enabled) {
    return json({ ok: false, d1: status, error: "D1 binding not found. Please bind SKY31_DB in Cloudflare Pages Settings > Functions > D1 database bindings." }, 500);
  }

  const env = withD1Store(context.env);
  const key = "sky31:d1_check:" + Date.now();
  await env.ORDERS.put(key, JSON.stringify({ ok: true, at: new Date().toISOString() }), { expirationTtl: 300 });
  const raw = await env.ORDERS.get(key);
  await env.ORDERS.delete(key);

  return json({
    ok: true,
    d1: status,
    writeReadDelete: !!raw,
    message: "D1 is connected and the Sky31 D1-only table is ready. KV fallback is disabled."
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
