
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    if (!body.customerName || !body.phone || !Array.isArray(body.cart) || !body.cart.length) {
      return json({ ok: false, error: "Missing order data" }, 400);
    }

    const orderNo = await nextOrderNo(env);
    const createdAt = new Date();
    const pickupTime = resolvePickupTime(body.pickup || "", createdAt);
    const cleanCart = normalizeCart(body.cart);

    let orderText = body.orderText || makeOrderText(orderNo, body.customerName, body.phone, pickupTime, cleanCart);
    orderText = orderText.replaceAll("{ORDER_NO}", "#" + orderNo);

    const order = {
      orderNo,
      status: "pending",
      customerName: body.customerName,
      phone: body.phone,
      pickup: body.pickup || "",
      pickupTime,
      cart: cleanCart,
      orderText,
      createdAt: createdAt.toISOString(),
      completedAt: null,
      pickedUpAt: null,
      telegramMessageId: null
    };

    const telegram = await sendTelegram(env, orderText, orderNo);
    if (telegram && telegram.ok && telegram.result && telegram.result.message_id) {
      order.telegramMessageId = telegram.result.message_id;
    }

    const ttl = 60 * 60 * 24 * 14;
    await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
    await env.ORDERS.put("phone:" + normalizePhone(body.phone) + ":" + orderNo, orderNo, { expirationTtl: ttl });

    return json({ ok: true, orderNo, status: order.status, pickupTime });
  } catch (e) {
    return json({ ok: false, error: e.message || "Server error" }, 500);
  }
}

async function nextOrderNo(env) {
  const d = new Date();
  const key = "counter:" + d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
  const current = parseInt(await env.ORDERS.get(key) || "0", 10);
  const next = current + 1;
  await env.ORDERS.put(key, String(next), { expirationTtl: 60 * 60 * 24 * 30 });
  return "A" + String(next).padStart(3, "0");
}

function normalizeCart(cart) {
  return cart.map(item => ({
    name: item.name || "",
    cn: item.cn || "",
    qty: Number(item.qty || 1),
    bean: item.bean || "",
    temp: item.temp || "",
    ice: item.ice || "",
    milk: item.milk || "",
    note: item.note || "",
    pickup: item.pickup || ""
  }));
}

function makeOrderText(orderNo, name, phone, pickupTime, cart) {
  const lines = [];
  lines.push("☕ SKY31 ORDER");
  lines.push("");
  lines.push("訂單號：#" + orderNo);
  lines.push("取餐時間：" + pickupTime);
  lines.push("");
  cart.forEach(item => {
    const details = [];
    if (item.bean) details.push(item.bean.split("｜")[0]);
    if (item.temp) details.push(item.temp);
    if (item.ice && item.ice !== "不適用") details.push(item.ice);
    if (item.milk) details.push(item.milk);
    lines.push("☕ " + (item.name || item.cn || "-") + " ×" + (item.qty || 1));
    if (details.length) lines.push(details.join("｜"));
  });
  lines.push("");
  lines.push("客人：" + name);
  lines.push("電話：" + phone);
  return lines.join("\n");
}

function resolvePickupTime(pickup, now) {
  const target = new Date(now.getTime());
  let label = pickup || "-";
  let slot = "";

  if (label.includes("明天早上")) {
    target.setDate(now.getDate() + 1);
    slot = "08:30-09:00";
  } else if (label.includes("明天中午")) {
    target.setDate(now.getDate() + 1);
    slot = "13:00-13:30";
  } else if (label.includes("30")) {
    target.setMinutes(now.getMinutes() + 30);
    slot = pad2(target.getHours()) + ":" + pad2(target.getMinutes());
    label = "30分鐘後";
  } else if (label.includes("即取") || label.includes("Now")) {
    slot = "ASAP";
    label = "即取";
  }

  if (slot) return formatDateOnly(target) + " " + slot + "（" + label + "）";
  return label;
}

async function sendTelegram(env, text, orderNo) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram env vars missing");

  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ 完成訂單 #" + orderNo, callback_data: "complete:" + orderNo }
      ]]
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return await res.json();
}

function normalizePhone(phone) { return String(phone || "").replace(/\D/g, ""); }
function pad2(n) { return String(n).padStart(2, "0"); }
function formatDateOnly(d) { return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
