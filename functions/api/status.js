
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const orderNo = (url.searchParams.get("orderNo") || "").trim().replace(/^#/, "").toUpperCase();
  const phone = normalizePhone(url.searchParams.get("phone") || "");

  if (!phone) {
    return json({ ok: false, error: "請輸入手機號碼" }, 400);
  }

  if (orderNo) {
    const raw = await env.ORDERS.get("order:" + orderNo);
    if (!raw) return json({ ok: false, error: "查詢不到此訂單號" }, 404);

    const order = JSON.parse(raw);
    if (normalizePhone(order.phone) !== phone) {
      return json({ ok: false, error: "手機號碼不正確" }, 403);
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
    orders.push(formatOrder(JSON.parse(raw)));
  }

  if (!orders.length) {
    return json({ ok: false, error: "查詢不到目前可顯示的訂單" }, 404);
  }

  return json({ ok: true, orders });
}

function formatOrder(order) {
  const cart = Array.isArray(order.cart) ? order.cart : [];

  return {
    ok: true,
    orderNo: order.orderNo,
    status: order.status || "pending",
    displayStatus: order.status || "pending",
    pickupTime: order.pickupTime || order.pickup || "",
    createdAt: order.createdAt || "",
    confirmedAt: order.confirmedAt || null,
    makingAt: order.makingAt || null,
    completedAt: order.completedAt || null,
    pickedUpAt: order.pickedUpAt || null,
    cancelledAt: order.cancelledAt || null,
    restoredAt: order.restoredAt || null,
    statusBeforeCancel: order.statusBeforeCancel || null,
    customerName: order.customerName || "",
    phone: order.phone || "",
    pickup: order.pickup || "",
    orderText: order.orderText || "",
    cart: cart.map(item => ({
      name: item.name || item.title || "",
      cn: item.cn || item.zh || "",
      qty: Number(item.qty || item.quantity || 1),
      image: item.image || "",
      bean: item.bean || "",
      flavor: item.flavor || "",
      temp: item.temp || item.temperature || "",
      ice: item.ice || "",
      milk: item.milk || "",
      pickup: item.pickup || "",
      note: item.note || ""
    }))
  };
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
