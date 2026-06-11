
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const customerName = String(body.customerName || body.name || "").trim();
    const phone = String(body.phone || "").trim();

    if (!customerName || !phone) {
      return json({ ok: false, error: "請輸入姓名和手機號碼" }, 400);
    }

    const rawCart = Array.isArray(body.cart) ? body.cart : [];
    const cleanCart = normalizeCart(rawCart);

    if (!cleanCart.length && !String(body.orderText || "").trim()) {
      return json({ ok: false, error: "請先選擇飲品" }, 400);
    }

    const orderNo = await nextOrderNo(env);
    const createdAt = new Date();
    const pickup = body.pickup || getPickupFromCart(cleanCart) || "Now 即取";
    const pickupTime = resolvePickupTime(pickup, createdAt);

    let orderText = String(body.orderText || "").trim();

    if (!orderText) {
      orderText = makeOrderText(orderNo, customerName, phone, pickupTime, cleanCart);
    } else {
      orderText = orderText.replaceAll("{ORDER_NO}", "#" + orderNo);
      if (!orderText.includes("#" + orderNo)) {
        orderText = "訂單號：#" + orderNo + "\n" + orderText;
      }
    }

    const order = {
      orderNo,
      status: "pending",
      customerName,
      phone,
      pickup,
      pickupTime,
      cart: cleanCart,
      orderText,
      createdAt: createdAt.toISOString(),
      completedAt: null,
      pickedUpAt: null,
      telegramMessageId: null,
      telegramOk: false,
      telegramError: null
    };

    const ttl = 60 * 60 * 24 * 14;

    // Save first. This prevents the webpage from freezing if Telegram is slow.
    await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
    await env.ORDERS.put("phone:" + normalizePhone(phone) + ":" + orderNo, orderNo, { expirationTtl: ttl });

    // Telegram is best-effort. It has a timeout and will not block customer checkout forever.
    try {
      const telegram = await sendTelegramWithTimeout(env, orderText, orderNo, 6000);
      if (telegram && telegram.ok && telegram.result && telegram.result.message_id) {
        order.telegramOk = true;
        order.telegramMessageId = telegram.result.message_id;
        await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
      } else {
        order.telegramError = telegram ? JSON.stringify(telegram).slice(0, 500) : "Telegram no response";
        await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
      }
    } catch (telegramError) {
      order.telegramError = telegramError.message || "Telegram failed";
      await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
    }

    return json({
      ok: true,
      orderNo,
      status: order.status,
      pickupTime,
      telegramOk: order.telegramOk
    });
  } catch (e) {
    return json({ ok: false, error: e.message || "提交失敗，請稍後再試" }, 500);
  }
}

async function nextOrderNo(env) {
  const d = new Date();
  const key = "counter:" + d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const current = parseInt(await env.ORDERS.get(key) || "0", 10);
  const next = current + 1;
  await env.ORDERS.put(key, String(next), { expirationTtl: 60 * 60 * 24 * 30 });
  return "A" + String(next).padStart(3, "0");
}

function normalizeCart(cart) {
  return cart.map(item => ({
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
  }));
}

function getPickupFromCart(cart) {
  if (!Array.isArray(cart) || !cart.length) return "";
  return cart[0].pickup || "";
}

function makeOrderText(orderNo, name, phone, pickupTime, cart) {
  const lines = [];
  lines.push("☕ SKY31 ORDER");
  lines.push("");
  lines.push("訂單號：#" + orderNo);
  lines.push("取餐時間：" + pickupTime);
  lines.push("");

  if (Array.isArray(cart) && cart.length) {
    cart.forEach(item => {
      const title = item.name || item.cn || "-";
      lines.push("☕ " + title + " ×" + (item.qty || 1));

      const details = [];
      if (item.cn && item.cn !== item.name) details.push(item.cn);
      if (item.bean) details.push(item.bean);
      if (item.flavor) details.push("風味：" + item.flavor);
      if (item.temp) details.push(item.temp);
      if (item.ice && item.ice !== "不適用") details.push(item.ice);
      if (item.milk) details.push(item.milk);
      if (item.pickup) details.push(item.pickup);
      if (item.note && item.note !== "無備註") details.push("備註：" + item.note);
      if (details.length) lines.push(details.join("｜"));
      lines.push("");
    });
  }

  lines.push("客人：" + name);
  lines.push("電話：" + phone);
  return lines.join("\n").trim();
}

function resolvePickupTime(pickup, now) {
  const target = new Date(now.getTime());
  let label = pickup || "Now 即取";
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
  } else if (label.includes("即取") || label.includes("即刻") || label.includes("Now")) {
    slot = "ASAP";
    label = "即取";
  }

  if (slot) return formatDateOnly(target) + " " + slot + "（" + label + "）";
  return label;
}

async function sendTelegramWithTimeout(env, text, orderNo, timeoutMs) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram env vars missing");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
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
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateOnly(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
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
