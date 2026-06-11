
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

    let orderText = body.orderText || "";
    orderText = orderText.replaceAll("{ORDER_NO}", "#" + orderNo);

    const order = {
      orderNo,
      status: "pending",
      customerName: body.customerName,
      phone: body.phone,
      pickup: body.pickup || "",
      pickupTime,
      cart: body.cart,
      createdAt: createdAt.toISOString(),
      completedAt: null,
      telegramMessageId: null
    };

    const telegram = await sendTelegram(env, orderText, orderNo);
    if (telegram && telegram.ok && telegram.result && telegram.result.message_id) {
      order.telegramMessageId = telegram.result.message_id;
    }

    await env.ORDERS.put("order:" + orderNo, JSON.stringify(order));
    await env.ORDERS.put("phone:" + normalizePhone(body.phone) + ":" + orderNo, orderNo);

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
  await env.ORDERS.put(key, String(next));

  return "A" + String(next).padStart(3, "0");
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

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}
function pad2(n) { return String(n).padStart(2, "0"); }
function formatDateOnly(d) { return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
