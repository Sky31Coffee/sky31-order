
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let orderNo = (url.searchParams.get("orderNo") || "").trim().replace(/^#/, "").toUpperCase();
  const phone = normalizePhone(url.searchParams.get("phone") || "");

  if (!phone) return json({ ok: false, error: "請輸入手機號碼" }, 400);

  if (orderNo) {
    const raw = await env.ORDERS.get("order:" + orderNo);
    if (!raw) return json({ ok: false, error: "查詢不到訂單" }, 404);
    const order = JSON.parse(raw);
    if (normalizePhone(order.phone) !== phone) return json({ ok: false, error: "手機號碼不正確" }, 403);
    return json(formatOrder(order));
  }

  const prefix = "phone:" + phone + ":";
  const listed = await env.ORDERS.list({ prefix });

  if (!listed.keys || !listed.keys.length) return json({ ok: false, error: "查詢不到此手機號碼的訂單" }, 404);

  const orderNos = listed.keys.map(k => k.name.replace(prefix, "")).filter(Boolean).sort().reverse().slice(0, 5);
  const orders = [];

  for (const no of orderNos) {
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;
    orders.push(formatOrder(JSON.parse(raw)));
  }

  if (!orders.length) return json({ ok: false, error: "查詢不到此手機號碼的訂單" }, 404);
  return json({ ok: true, orders });
}

function formatOrder(order) {
  return {
    ok: true,
    orderNo: order.orderNo,
    status: order.status,
    pickupTime: order.pickupTime,
    createdAt: order.createdAt,
    completedAt: order.completedAt,
    cart: Array.isArray(order.cart) ? order.cart.map(item => ({
      name: item.name || "",
      cn: item.cn || "",
      qty: item.qty || 1,
      bean: item.bean || "",
      temp: item.temp || "",
      ice: item.ice || "",
      milk: item.milk || "",
      note: item.note || ""
    })) : []
  };
}

function normalizePhone(phone) { return String(phone || "").replace(/\D/g, ""); }
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
