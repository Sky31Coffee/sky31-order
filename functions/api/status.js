
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let orderNo = (url.searchParams.get("orderNo") || "").trim().replace(/^#/, "").toUpperCase();
  const phone = normalizePhone(url.searchParams.get("phone") || "");

  if (!orderNo || !phone) {
    return json({ ok: false, error: "請輸入訂單號和手機號碼" }, 400);
  }

  const raw = await env.ORDERS.get("order:" + orderNo);
  if (!raw) {
    return json({ ok: false, error: "查詢不到訂單" }, 404);
  }

  const order = JSON.parse(raw);
  if (normalizePhone(order.phone) !== phone) {
    return json({ ok: false, error: "手機號碼不正確" }, 403);
  }

  return json({
    ok: true,
    orderNo: order.orderNo,
    status: order.status,
    pickupTime: order.pickupTime,
    createdAt: order.createdAt,
    completedAt: order.completedAt
  });
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
