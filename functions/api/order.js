
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
    const cart = normalizeCart(rawCart);

    if (!cart.length && !String(body.orderText || "").trim()) {
      return json({ ok: false, error: "請先選擇飲品" }, 400);
    }

    const orderNo = await nextOrderNo(env);
    const createdAt = new Date();
    const pickup = body.pickup || getPickupFromCart(cart) || "Now 即取";
    const pickupTime = resolvePickupTime(pickup, createdAt);

    const order = {
      orderNo,
      status: "pending",
      customerName,
      phone,
      pickup,
      pickupTime,
      cart,
      orderText: "",
      createdAt: createdAt.toISOString(),
      completedAt: null,
      pickedUpAt: null,
      telegramMessageId: null
    };

    order.orderText = buildTelegramText(order);

    const ttl = 60 * 60 * 24 * 14;
    await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
    await env.ORDERS.put("phone:" + normalizePhone(phone) + ":" + orderNo, orderNo, { expirationTtl: ttl });

    const bg = sendTelegram(env, order.orderText, orderNo)
      .then(async tg => {
        try {
          if (tg && tg.ok && tg.result && tg.result.message_id) {
            order.telegramMessageId = tg.result.message_id;
            await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
          }
        } catch (_) {}
      })
      .catch(() => {});

    if (context.waitUntil) context.waitUntil(bg);

    return json({ ok: true, orderNo, status: order.status, pickupTime });
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
  return Array.isArray(cart) && cart.length ? (cart[0].pickup || "") : "";
}

function buildTelegramText(order) {
  const lines = [];
  lines.push("☕ SKY31 ORDER");
  lines.push("");
  lines.push("訂單號：#" + (order.orderNo || ""));
  if (order.createdAt) lines.push("下單時間：" + formatDateTime(order.createdAt));
  lines.push("");
  lines.push("取餐時間：");
  lines.push(order.pickupTime || order.pickup || "-");
  lines.push("");
  lines.push("────────────");
  lines.push("");

  if (Array.isArray(order.cart) && order.cart.length) {
    order.cart.forEach(item => {
      if (item.bean) lines.push(beanIcon(item.bean) + " " + cleanBeanName(item.bean));
      const title = item.name || item.cn || "-";
      const parts = [];
      if (item.temp) parts.push(item.temp.includes("Hot") || item.temp.includes("熱") ? "🔥 Hot" : item.temp);
      if (item.ice && item.ice !== "不適用") parts.push(item.ice);
      if (item.milk) parts.push(item.milk);
      lines.push("☕ " + title + " ×" + (item.qty || 1) + (parts.length ? " | " + parts.join(" | ") : ""));
      if (item.note && item.note !== "無備註") lines.push("備註：" + item.note);
      lines.push("");
    });
  }

  lines.push("────────────");
  lines.push("客人：" + (order.customerName || ""));
  lines.push("電話：" + (order.phone || ""));
  lines.push("");
  lines.push("提示：完成後可在 Telegram 按「完成訂單」。");

  return lines.join("\n").trim();
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
        { text: "✅ 完成訂單 #" + orderNo, callback_data: "complete:" + orderNo },
        { text: "❌ 取消訂單 #" + orderNo, callback_data: "cancel:" + orderNo }
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

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}


function beanIcon(bean) {
  bean = String(bean || "");
  if (bean.includes("淺烘") || bean.includes("浅烘")) return "🌸";
  if (bean.includes("中深烘") || bean.includes("拼配")) return "🍫";
  return "☕";
}

function cleanBeanName(bean) {
  return String(bean || "").split("|")[0].split("｜")[0].trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateOnly(d) {
  d = new Date(d);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function formatDateTime(d) {
  d = new Date(d);
  return formatDateOnly(d) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
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
