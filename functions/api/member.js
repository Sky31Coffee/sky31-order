export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const phone = normalizePhone(url.searchParams.get("phone") || "");

  if (!phone) {
    return json({ ok: false, error: "請輸入手機號碼" }, 400);
  }

  const member = await loadMember(env, phone);
  if (!member) {
    return json({ ok: false, error: "查詢不到會員資料" }, 404);
  }

  const withStats = await enrichMemberWithOrders(env, member);
  return json({ ok: true, member: withStats });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const phone = normalizePhone(body.phone || "");
    const name = String(body.name || body.customerName || "").trim();
    const birthday = String(body.birthday || "").trim();
    const note = String(body.note || "").trim();

    if (!phone || !name) {
      return json({ ok: false, error: "請輸入姓名和手機號碼" }, 400);
    }

    const existing = await loadMember(env, phone);
    if (existing) {
      return json({ ok: false, error: "此電話已註冊，不能重複註冊。請直接登入。" }, 409);
    }

    const now = new Date().toISOString();

    const member = {
      phone,
      name,
      birthday,
      note,
      createdAt: now,
      updatedAt: now,
      historyStartAt: now,
      totalOrders: 0,
      totalCups: 0,
      totalSpent: 0,
      recentOrderNos: []
    };

    await env.ORDERS.put("member:" + phone, JSON.stringify(member));

    const withStats = await enrichMemberWithOrders(env, member);

    const bg = sendMemberTelegram(env, withStats)
      .catch(() => {});
    if (context.waitUntil) context.waitUntil(bg);
    else await bg;

    return json({ ok: true, member: withStats });
  } catch (e) {
    return json({ ok: false, error: e.message || "保存會員失敗" }, 500);
  }
}

async function loadMember(env, phone) {
  const raw = await env.ORDERS.get("member:" + phone);
  if (!raw) return null;
  try {
    const member = JSON.parse(raw);
    if (member && member.deletedAt) return null;
    return member;
  } catch (_) {
    return null;
  }
}

async function enrichMemberWithOrders(env, member) {
  const phone = normalizePhone(member.phone);
  const prefix = "phone:" + phone + ":";
  const listed = await env.ORDERS.list({ prefix });

  const orderNos = (listed.keys || [])
    .map(k => k.name.replace(prefix, ""))
    .filter(Boolean)
    .sort()
    .reverse();

  const orders = [];
  let totalOrders = 0;
  let totalCups = 0;
  let totalSpent = 0;
  const historyStartAt = member.historyStartAt ? new Date(member.historyStartAt).getTime() : 0;

  for (const no of orderNos) {
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;

    let order = null;
    try { order = JSON.parse(raw); } catch (_) { continue; }
    if (!order || normalizePhone(order.phone) !== phone) continue;

    if (historyStartAt && order.createdAt) {
      const orderAt = new Date(order.createdAt).getTime();
      if (Number.isFinite(orderAt) && orderAt < historyStartAt) continue;
    }

    const cups = orderCups(order);
    const amount = Number(order.totalAmount || cartTotal(order.cart) || 0);
    const cancelled = order.status === "cancelled";

    if (!cancelled) {
      totalOrders += 1;
      totalCups += cups;
      totalSpent += amount;
    }

    if (orders.length < 10) {
      orders.push({
        orderNo: order.orderNo || no,
        status: order.status || "pending",
        createdAt: order.createdAt || "",
        pickupTime: order.pickupTime || order.pickup || "",
        totalCups: cups,
        totalAmount: Math.round(amount * 100) / 100,
        currency: order.currency || "MOP",
        cart: normalizeCart(order.cart, order.currency || "MOP")
      });
    }
  }

  return {
    phone,
    name: member.name || "",
    birthday: member.birthday || "",
    note: member.note || "",
    createdAt: member.createdAt || "",
    updatedAt: member.updatedAt || "",
    historyStartAt: member.historyStartAt || "",
    lastOrderAt: member.lastOrderAt || "",
    lastOrderNo: member.lastOrderNo || "",
    totalOrders,
    totalCups,
    totalSpent: Math.round(totalSpent * 100) / 100,
    recentOrders: orders
  };
}

async function sendMemberTelegram(env, member) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;

  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  const payload = {
    chat_id: chatId,
    text: buildMemberTelegramText(member, false),
    reply_markup: buildMemberReplyMarkup(member)
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => null);
  if (data && data.ok && data.result && data.result.message_id) {
    try {
      const activeRaw = await env.ORDERS.get("member:" + normalizePhone(member.phone));
      if (activeRaw) {
        const active = JSON.parse(activeRaw);
        active.telegramMemberMessageId = data.result.message_id;
        active.telegramMemberChatId = chatId;
        await env.ORDERS.put("member:" + normalizePhone(member.phone), JSON.stringify(active));
      }
    } catch (_) {}
  }

  return data;
}

function buildMemberTelegramText(member, deleted = false) {
  const lines = [];
  lines.push("👤 SKY31 MEMBER");
  lines.push("");
  lines.push(deleted ? "狀態：已刪除" : "狀態：已註冊");
  lines.push("姓名：" + (member.name || "-"));
  lines.push("電話：" + (member.phone || "-"));
  lines.push("生日：" + (member.birthday || "-"));
  if (member.note) lines.push("備註：" + member.note);
  if (member.createdAt) lines.push("註冊時間：" + formatDateTime(member.createdAt));
  if (member.deletedAt) lines.push("刪除時間：" + formatDateTime(member.deletedAt));
  if (member.restoredAt) lines.push("恢復時間：" + formatDateTime(member.restoredAt));
  lines.push("");
  lines.push("累積訂單：" + Number(member.totalOrders || 0));
  lines.push("累積杯數：" + Number(member.totalCups || 0));
  lines.push("累積消費：MOP " + String(Math.round(Number(member.totalSpent || 0) * 100) / 100));
  lines.push("");
  lines.push("提示：刪除後，客戶無法再用此會員登入；如需要可重新註冊。");
  return lines.join("\n").trim();
}

function buildMemberReplyMarkup(member) {
  const phone = normalizePhone(member.phone);
  return {
    inline_keyboard: [[
      { text: "🗑️ 刪除", callback_data: "member_delete:" + phone },
      { text: "↩️ 恢復", callback_data: "member_restore:" + phone }
    ]]
  };
}

function normalizeCart(cart, currency = "MOP") {
  return (Array.isArray(cart) ? cart : []).map(item => {
    const qty = Number(item.qty || item.quantity || 1);
    const unit = Number(item.unitPrice || item.price || 0);
    return {
      name: item.name || item.title || "",
      cn: item.cn || item.zh || "",
      qty,
      bean: item.bean || "",
      temp: item.temp || item.temperature || "",
      ice: item.ice || "",
      milk: item.milk || "",
      pickup: item.pickup || "",
      note: item.note || "",
      unitPrice: unit,
      price: unit,
      subtotal: Number(item.subtotal || unit * qty || 0),
      currency: item.currency || currency
    };
  });
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function orderCups(order) {
  return Array.isArray(order.cart)
    ? order.cart.reduce((sum, item) => sum + Number(item.qty || item.quantity || 1), 0)
    : 0;
}

function cartTotal(cart) {
  return (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
    const qty = Number(item.qty || item.quantity || 1);
    const unit = Number(item.unitPrice || item.price || 0);
    const subtotal = Number(item.subtotal || unit * qty || 0);
    return sum + subtotal;
  }, 0);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateTime(d) {
  d = new Date(d);
  if (isNaN(d.getTime())) return "-";
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
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
