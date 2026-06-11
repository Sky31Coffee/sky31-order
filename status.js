
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
    if (!shouldShowToCustomer(order)) return json({ ok: false, error: "此訂單已領取或已完成超過1小時" }, 404);
    return json(formatOrder(order));
  }

  const prefix = "phone:" + phone + ":";
  const listed = await env.ORDERS.list({ prefix });
  if (!listed.keys || !listed.keys.length) return json({ ok: false, error: "查詢不到目前可顯示的訂單" }, 404);

  const orderNos = listed.keys.map(k => k.name.replace(prefix, "")).filter(Boolean).sort().reverse();
  const orders = [];

  for (const no of orderNos) {
    if (orders.length >= 3) break;
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;
    const order = JSON.parse(raw);
    if (!shouldShowToCustomer(order)) continue;
    orders.push(formatOrder(order));
  }

  if (!orders.length) return json({ ok: false, error: "目前沒有可顯示的訂單" }, 404);
  return json({ ok: true, orders });
}

function shouldShowToCustomer(order) {
  if (!order) return false;
  if (order.status === "picked_up") return false;

  if (order.status === "completed" && order.completedAt) {
    const completedAt = new Date(order.completedAt).getTime();
    if (!completedAt) return true;
    const oneHour = 60 * 60 * 1000;
    return Date.now() - completedAt <= oneHour;
  }

  return true;
}

function displayStatus(order) {
  if (order.status === "completed" && order.completedAt) {
    const completedAt = new Date(order.completedAt).getTime();
    const fiveMin = 5 * 60 * 1000;
    if (completedAt && Date.now() - completedAt >= fiveMin) return "picked_up";
  }
  return order.status;
}

function formatOrder(order) {
  let cart = Array.isArray(order.cart) ? order.cart : [];
  if (!cart.length && order.orderText) cart = parseCartFromOrderText(order.orderText);

  return {
    ok: true,
    orderNo: order.orderNo,
    status: order.status,
    displayStatus: displayStatus(order),
    pickupTime: order.pickupTime,
    createdAt: order.createdAt,
    completedAt: order.completedAt,
    orderText: order.orderText || "",
    cart: cart.map(item => ({
      name: item.name || "",
      cn: item.cn || "",
      qty: item.qty || 1,
      bean: item.bean || "",
      temp: item.temp || "",
      ice: item.ice || "",
      milk: item.milk || "",
      note: item.note || ""
    }))
  };
}

function parseCartFromOrderText(text) {
  const lines = String(text || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let m = line.match(/(?:☕\s*)?(.+?)\s*[×x]\s*(\d+)/i);
    if (!m) continue;

    const name = m[1]
      .replace(/^[-•\d.\s]+/, "")
      .replace(/^(SKY31 ORDER|訂單號|取餐時間|客人|電話).*/i, "")
      .trim();

    if (!name || name.length > 60) continue;

    const detailsLine = lines[i + 1] || "";
    const item = {
      name,
      qty: Number(m[2] || 1),
      bean: "",
      temp: "",
      ice: "",
      milk: "",
      note: ""
    };

    if (detailsLine && !/[×x]\s*\d+/.test(detailsLine)) {
      const parts = detailsLine.split(/[｜|]/).map(s => s.trim()).filter(Boolean);
      parts.forEach(p => {
        if (/淺烘|中深|House|SOE|Geisha|豆/.test(p)) item.bean = p;
        else if (/Hot|熱|Iced|凍|冰/.test(p) && !/冰量|少冰|多冰|正常冰/.test(p)) item.temp = p;
        else if (/少冰|多冰|正常冰|冰量/.test(p)) item.ice = p;
        else if (/奶|Milk|牛乳/.test(p)) item.milk = p;
        else if (/備註/.test(p)) item.note = p.replace(/^備註[:：]?/, "");
      });
    }

    items.push(item);
  }

  return items;
}

function normalizePhone(phone) { return String(phone || "").replace(/\D/g, ""); }
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
