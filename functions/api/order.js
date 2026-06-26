
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const submittedCustomerName = String(body.customerName || body.name || "").trim();
    const submittedPhone = String(body.phone || "").trim();

    if (!submittedCustomerName || !submittedPhone) {
      return json({ ok: false, error: "請輸入姓名和手機號碼" }, 400);
    }

    const activeMember = await ensureActiveMember(env, submittedPhone);
    const phone = normalizePhone(activeMember.phone || submittedPhone);
    const customerName = String(activeMember.name || submittedCustomerName).trim() || submittedCustomerName;

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
      orderId: orderNo,
      status: "pending",
      customerName,
      phone,
      memberPhone: phone,
      memberName: activeMember.name || customerName,
      submittedPhone: normalizePhone(submittedPhone),
      pickup,
      pickupTime,
      totalAmount: cartTotal(cart),
      currency: "MOP",
      cart,
      orderText: "",
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      statusUpdatedAt: createdAt.toISOString(),
      completedAt: null,
      pickedUpAt: null,
      telegramMessageId: null
    };

    order.orderText = buildTelegramText(order);

    const ttl = 60 * 60 * 24 * 3650; // V166: long-term order/member history
    await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
    await saveOrderMemberIndexes(env, order, ttl);
    try { await updateMemberAfterOrder(env, order, ttl); } catch (_) {}

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

    return json({ ok: true, orderNo, status: order.status, pickupTime, totalAmount: order.totalAmount, currency: order.currency });
  } catch (e) {
    return json({ ok: false, error: e.message || "提交失敗，請稍後再試" }, 500);
  }
}


async function ensureActiveMember(env, phone) {
  phone = normalizePhone(phone);
  if (!phone) throw new Error("會員資料不存在或已被刪除，請重新登入或重新註冊");

  const candidates = memberPhoneCandidates(phone);

  for (const candidate of candidates) {
    const raw = await env.ORDERS.get("member:" + candidate);
    if (!raw) continue;

    try {
      const member = JSON.parse(raw);
      if (member && !member.deletedAt) {
        member.phone = normalizePhone(member.phone || candidate);
        return member;
      }
    } catch (_) {}
  }

  // Fallback: older member data may be saved with 853 / non-853 phone key.
  let cursor = undefined;
  let checked = 0;

  do {
    const page = await env.ORDERS.list({ prefix: "member:", cursor });

    for (const key of (page.keys || [])) {
      checked += 1;
      if (checked > 500) break;

      const keyPhone = normalizePhone(key.name.replace("member:", ""));
      const raw = await env.ORDERS.get(key.name);
      if (!raw) continue;

      try {
        const member = JSON.parse(raw);
        if (!member || member.deletedAt) continue;

        const storedPhone = normalizePhone(member.phone || keyPhone);

        if (samePhoneForMemberLookup(storedPhone, phone) || samePhoneForMemberLookup(keyPhone, phone)) {
          member.phone = storedPhone || keyPhone || phone;

          const normalizedKey = "member:" + phone;
          if (key.name !== normalizedKey) {
            try { await env.ORDERS.put(normalizedKey, JSON.stringify(member)); } catch (_) {}
          }

          return member;
        }
      } catch (_) {}
    }

    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);

  throw new Error("會員資料不存在或已被刪除，請重新登入或重新註冊");
}

async function nextOrderNo(env) {
  // V167: permanent unique order number.
  // Old daily A001/A002 reset caused duplicate order keys after midnight.
  // Since orderNo is used for KV order:<orderNo> and Telegram callbacks,
  // it must never repeat.
  const counter = await env.ORDERS.get("global_order_counter");
  const next = Number(counter || 0) + 1;

  if (!Number.isFinite(next) || next <= 0) {
    throw new Error("訂單編號產生失敗");
  }

  await env.ORDERS.put("global_order_counter", String(next));

  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const serial = String(next).padStart(6, "0");

  return "S" + yy + mm + dd + serial;
}


const SKY31_PRICE_TABLE = {
  americano: { hot: 28, iced: 35 },
  latte: { hot: 40, iced: 45 },
  cappuccino: { hot: 40, iced: 45 },
  mocha: { hot: 38, iced: 43 },
  chocolate: { hot: 30, iced: 35 },
  dirty: { fixed: 38 }
};

function priceKeyByName(name, cn) {
  const n = String(name || "").toLowerCase().replace(/\s+/g, "") + " " + String(cn || "").toLowerCase().replace(/\s+/g, "");
  if (n.includes("dirty") || n.includes("髒") || n.includes("脏")) return "dirty";
  if (n.includes("americano") || n.includes("美式")) return "americano";
  if (n.includes("latte") || n.includes("拿鐵") || n.includes("拿铁")) return "latte";
  if (n.includes("cappuccino") || n.includes("卡布")) return "cappuccino";
  if (n.includes("mocha") || n.includes("摩卡")) return "mocha";
  if (n.includes("chocolate") || n.includes("可可")) return "chocolate";
  return "";
}

function calcUnitPrice(item) {
  const key = priceKeyByName(item.name || item.title, item.cn || item.zh);
  const table = SKY31_PRICE_TABLE[key];
  if (!table) return Number(item.unitPrice || item.price || 0);
  if (table.fixed) return table.fixed;
  const temp = String(item.temp || item.temperature || "");
  const iced = temp.includes("Iced") || temp.includes("凍") || temp.includes("冻");
  return iced ? table.iced : table.hot;
}

function money(n) {
  return "MOP " + String(Math.round(Number(n || 0) * 100) / 100);
}

function cartTotal(cart) {
  return (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
    const qty = Number(item.qty || item.quantity || 1);
    const unit = Number(item.unitPrice || item.price || calcUnitPrice(item) || 0);
    return sum + unit * qty;
  }, 0);
}

function normalizeCart(cart) {
  return cart.map(item => {
    const base = {
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
    };
    const unit = calcUnitPrice(base);
    base.unitPrice = unit;
    base.price = unit;
    base.subtotal = unit * base.qty;
    base.currency = "MOP";
    return base;
  });
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
      lines.push("☕ " + title + " ×" + (item.qty || 1) + (parts.length ? " | " + parts.join(" | ") : "") + " | " + money(item.unitPrice || item.price || 0) + " × " + (item.qty || 1) + " = " + money(item.subtotal || 0));
      if (item.note && item.note !== "無備註") lines.push("備註：" + item.note);
      lines.push("");
    });
  }

  lines.push("────────────");
  lines.push("總額：" + money(order.totalAmount || cartTotal(order.cart)));
  lines.push("客人：" + (order.customerName || ""));
  lines.push("電話：" + (order.phone || ""));
  lines.push("");
  lines.push("提示：收到訂單後可在 Telegram 按「確認訂單」。");

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
        { text: "✅ 確認訂單 #" + orderNo, callback_data: "confirm:" + orderNo },
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
  } else if (label.includes("明天晚上") || label.includes("Tomorrow Evening") || label.includes("Tomorrow PM")) {
    target.setDate(now.getDate() + 1);
    slot = "20:00-21:00";
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

function phoneWithoutMacauCode(phone) {
  phone = normalizePhone(phone);
  if (phone.length === 11 && phone.startsWith("853")) return phone.slice(3);
  return phone;
}

function samePhoneForMemberLookup(a, b) {
  a = normalizePhone(a);
  b = normalizePhone(b);
  if (!a || !b) return false;
  if (a === b) return true;
  return phoneWithoutMacauCode(a) === phoneWithoutMacauCode(b);
}

function memberPhoneCandidates(phone) {
  phone = normalizePhone(phone);
  const out = [];
  if (phone) out.push(phone);
  if (phone.length === 8) out.push("853" + phone);
  if (phone.length === 11 && phone.startsWith("853")) out.push(phone.slice(3));
  return Array.from(new Set(out.filter(Boolean)));
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


async function saveOrderMemberIndexes(env, order, ttl) {
  const phones = []
    .concat(memberPhoneCandidates(order.phone))
    .concat(memberPhoneCandidates(order.memberPhone))
    .concat(memberPhoneCandidates(order.submittedPhone));

  const uniquePhones = Array.from(new Set(phones.map(normalizePhone).filter(Boolean)));

  for (const phone of uniquePhones) {
    await env.ORDERS.put("phone:" + phone + ":" + order.orderNo, order.orderNo, { expirationTtl: ttl });
    await env.ORDERS.put("member_ordered:" + phone + ":" + order.orderNo, order.orderNo, { expirationTtl: ttl || 60 * 60 * 24 * 3650 });
  }
}

async function updateMemberAfterOrder(env, order, ttl) {
  const phone = normalizePhone(order.memberPhone || order.phone);
  if (!phone || !order.orderNo) return;

  // Important:
  // member_ordered:<phone>:<orderNo> is only an index for history lookup.
  // Do NOT use it as the "already counted" marker, because saveOrderMemberIndexes()
  // creates it before stats are updated. Using the same marker caused totalCups /
  // totalOrders / totalSpent to stop accumulating.
  const countedKey = "member_stats_counted:" + phone + ":" + order.orderNo;
  const alreadyCounted = await env.ORDERS.get(countedKey);
  if (alreadyCounted) return;

  const now = new Date().toISOString();
  const key = "member:" + phone;
  let member = null;

  try {
    const raw = await env.ORDERS.get(key);
    member = raw ? JSON.parse(raw) : null;
  } catch (_) {
    member = null;
  }

  if (!member || typeof member !== "object") {
    member = {
      phone,
      name: order.memberName || order.customerName || "",
      birthday: "",
      note: "",
      createdAt: now,
      totalOrders: 0,
      totalCups: 0,
      totalSpent: 0,
      recentOrderNos: []
    };
  }

  const cups = orderCups(order);
  const total = Number(order.totalAmount || cartTotal(order.cart) || 0);

  member.phone = normalizePhone(member.phone || phone);
  if (order.memberName || order.customerName) {
    member.name = member.name || order.memberName || order.customerName;
  }

  member.updatedAt = now;
  member.lastOrderAt = order.updatedAt || order.statusUpdatedAt || order.createdAt || now;
  member.lastOrderNo = order.orderNo;

  const cancelled = isCancelledOrder(order);

  if (!cancelled) {
    member.totalOrders = Number(member.totalOrders || 0) + 1;
    member.totalCups = Number(member.totalCups || 0) + cups;
    member.totalSpent = Math.round((Number(member.totalSpent || 0) + total) * 100) / 100;
  }

  const recent = Array.isArray(member.recentOrderNos) ? member.recentOrderNos : [];
  member.recentOrderNos = [order.orderNo].concat(recent.filter(no => no !== order.orderNo)).slice(0, 2000);

  await env.ORDERS.put(key, JSON.stringify(member));
  await env.ORDERS.put(countedKey, "1", { expirationTtl: ttl || 60 * 60 * 24 * 3650 });
}

function orderCups(order) {
  const cart = Array.isArray(order && order.cart) ? order.cart : [];
  return cart.reduce((sum, item) => {
    const qty = Number(item.qty || item.quantity || 1);
    return sum + (Number.isFinite(qty) && qty > 0 ? qty : 1);
  }, 0);
}

function isCancelledOrder(order) {
  const s = String(order && order.status || "").toLowerCase();
  return s === "cancelled" || s === "canceled" || s.indexOf("cancel") >= 0;
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
