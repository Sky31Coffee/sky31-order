import { withD1Store } from "../_d1-kv.js";
import { savePushSubscriptionV301 } from "../_push.js";

export async function onRequestPost(context) {
  const env = withD1Store(context.env);
  try {
    const body = await context.request.json();
    const phone = String(body.phone || body.memberPhone || "").replace(/\D/g, "");
    const subscription = body.subscription;
    if (!phone) return json({ ok: false, error: "missing phone" }, 400);
    if (!subscription || !subscription.endpoint) return json({ ok: false, error: "missing subscription" }, 400);
    const saved = await savePushSubscriptionV301(env, phone, subscription, {
      name: body.name || "",
      userAgent: context.request.headers.get("User-Agent") || "",
      platform: body.platform || ""
    });
    return json({ ok: true, saved });
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
