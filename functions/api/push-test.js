import { withD1Store } from "../_d1-kv.js";
import { sendTestPushToPhoneV301 } from "../_push.js";

export async function onRequestPost(context) {
  const env = withD1Store(context.env);
  try {
    const body = await context.request.json();
    const phone = String(body.phone || "").replace(/\D/g, "");
    if (!phone) return json({ ok: false, error: "missing phone" }, 400);
    const result = await sendTestPushToPhoneV301(env, phone);
    return json(result);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
