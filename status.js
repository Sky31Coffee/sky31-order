
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
    if (!shouldShowToCustomer(order)) {
      return json({ ok: false, error: "此訂單已完成超過1小時或已領取" }, 404);
    }

    return json(formatOrder(order));
  }

  const prefix = "phone:" + phone + ":";
  const listed = await env.ORDERS.list({ prefix });

  if (!listed.keys || !listed.keys.length) {
    return json({ ok: false, error: "查詢不到目前可顯示的訂單" }, 404);
  }

  const orderNos = listed.keys
    .map(k => k.name.replace(prefix, ""))
    .filter(Boolean)
    .sort()
    .reverse();

  const orders = [];

  for (const no of orderNos) {
    if (orders.length >= 3) break;

    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;

    const order = JSON.parse(raw);
    if (!shouldShowToCustomer(order)) continue;

    orders.push(formatOrder(order));
  }

  if (!orders.length) {
    return json({ ok: false, error: "目前沒有製作中或1小時內已完成的訂單" }, 404);
  }

  return json({ ok: true, orders });
}

function shouldShowToCustomer(order) {
  if (!order) return false;

  if (order.status === "picked_up") return false;
  if (order.status !== "completed") return true;

  if (!order.completedAt) return true;

  const completedAt = new Date(order.completedAt).getTime();
  if (!completedAt) return true;

  const oneHour = 60 * 60 * 1000;
  return Date.now() - completedAt <= oneHour;
}

function formatOrder(order) {
  return {
    ok: true,
    orderNo: order.orderNo,
    status: order.status,
    pickupTime: order.pickupTime,
    createdAt: order.createdAt,
    completedAt: order.completedAt,
    orderText: order.orderText || "",
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
