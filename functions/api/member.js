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
  phone = normalizePhone(phone);
  if (!phone) return null;

  // 1) Fast direct lookup with common phone variants.
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

  // 2) Fallback scan for older data whose KV key or stored phone uses another format.
  // This prevents the contradictory case:
  // login says not found, but registration says the phone already exists.
  let cursor = undefined;
  let checked = 0;

  do {
    const page = await env.ORDERS.list({ prefix: "member:", cursor });

    for (const key of (page.keys || [])) {
      checked += 1;
      if (checked > 3000) return null;

      const keyPhone = normalizePhone(key.name.replace("member:", ""));
      if (!samePhoneForMemberLookup(keyPhone, phone)) {
        // If the key itself does not match, still inspect stored phone below.
      }

      const raw = await env.ORDERS.get(key.name);
      if (!raw) continue;

      try {
        const member = JSON.parse(raw);
        if (!member || member.deletedAt) continue;

        const storedPhone = normalizePhone(member.phone || keyPhone);
        if (samePhoneForMemberLookup(storedPhone, phone) || samePhoneForMemberLookup(keyPhone, phone)) {
          member.phone = storedPhone || keyPhone || phone;

          // Self-heal: save a normalized lookup key for future fast login.
          const normalizedKey = "member:" + phone;
          if (key.name !== normalizedKey) {
            try {
              await env.ORDERS.put(normalizedKey, JSON.stringify(member));
            } catch (_) {}
          }

          return member;
        }
      } catch (_) {}
    }

    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);

  return null;
}

async function enrichMemberWithOrders(env, member) {
  const phone = normalizePhone(member.phone);
  const orderNos = await collectMemberOrderNos(env, phone, member);

  const allOrders = [];
  let totalOrders = 0;
  let totalCups = 0;
  let totalSpent = 0;
  const historyStartAt = member.historyStartAt ? new Date(member.historyStartAt).getTime() : 0;

  for (const no of orderNos) {
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;

    let order = null;
    try { order = JSON.parse(raw); } catch (_) { continue; }

    if (!order) continue;

    const orderPhones = [
      normalizePhone(order.phone),
      normalizePhone(order.memberPhone),
      normalizePhone(order.submittedPhone)
    ].filter(Boolean);

    const belongs = orderPhones.some(p => samePhoneForMemberLookup(p, phone));
    if (!belongs) continue;

    if (historyStartAt && order.createdAt) {
      const orderAt = new Date(order.createdAt).getTime();
      if (Number.isFinite(orderAt) && orderAt < historyStartAt) continue;
    }

    const cups = orderCups(order);
    const amount = Number(order.totalAmount || cartTotal(order.cart) || 0);
    const cancelled = isCancelledOrder(order);

    if (!cancelled) {
      totalOrders += 1;
      totalCups += cups;
      totalSpent += amount;
    }

    allOrders.push({
      orderNo: order.orderNo || no,
      status: order.status || "pending",
      createdAt: order.createdAt || "",
      updatedAt: order.updatedAt || order.statusUpdatedAt || order.createdAt || "",
      statusUpdatedAt: order.statusUpdatedAt || order.updatedAt || "",
      confirmedAt: order.confirmedAt || null,
      makingAt: order.makingAt || null,
      completedAt: order.completedAt || null,
      pickedUpAt: order.pickedUpAt || null,
      cancelledAt: order.cancelledAt || order.canceledAt || null,
      pickupTime: order.pickupTime || order.pickup || "",
      totalCups: cups,
      totalAmount: Math.round(amount * 100) / 100,
      currency: order.currency || "MOP",
      cart: normalizeCart(order.cart, order.currency || "MOP")
    });
  }

  const sortedOrders = sortOrdersForMember(allOrders);

  // Lifetime totals should not go backwards.
  // Some older versions only stored a limited recent list or failed to increment
  // totalCups after member_ordered existed. Use the larger value between the
  // persisted member totals and the totals recomputed from all available orders.
  const finalTotalOrders = Math.max(Number(member.totalOrders || 0), totalOrders);
  const finalTotalCups = Math.max(Number(member.totalCups || 0), totalCups);
  const finalTotalSpent = Math.max(Number(member.totalSpent || 0), Math.round(totalSpent * 100) / 100);

  const fixedMember = {
    ...member,
    phone,
    updatedAt: member.updatedAt || "",
    lastOrderAt: sortedOrders[0] ? (sortedOrders[0].updatedAt || sortedOrders[0].createdAt || "") : (member.lastOrderAt || ""),
    lastOrderNo: sortedOrders[0] ? sortedOrders[0].orderNo : (member.lastOrderNo || ""),
    totalOrders: finalTotalOrders,
    totalCups: finalTotalCups,
    totalSpent: Math.round(finalTotalSpent * 100) / 100,
    recentOrderNos: sortedOrders.map(o => o.orderNo).filter(Boolean).slice(0, 2000)
  };

  // Repair stuck counters in KV when possible, so the account no longer stays
  // capped at the previous value such as 6 cups.
  try {
    if (
      Number(member.totalOrders || 0) !== fixedMember.totalOrders ||
      Number(member.totalCups || 0) !== fixedMember.totalCups ||
      Number(member.totalSpent || 0) !== fixedMember.totalSpent ||
      JSON.stringify(member.recentOrderNos || []) !== JSON.stringify(fixedMember.recentOrderNos || [])
    ) {
      await env.ORDERS.put("member:" + phone, JSON.stringify(fixedMember));
    }
  } catch (_) {}

  return {
    phone,
    name: fixedMember.name || "",
    birthday: fixedMember.birthday || "",
    note: fixedMember.note || "",
    createdAt: fixedMember.createdAt || "",
    updatedAt: fixedMember.updatedAt || "",
    historyStartAt: fixedMember.historyStartAt || "",
    lastOrderAt: fixedMember.lastOrderAt || "",
    lastOrderNo: fixedMember.lastOrderNo || "",
    totalOrders: fixedMember.totalOrders,
    totalCups: fixedMember.totalCups,
    totalSpent: fixedMember.totalSpent,
    recentOrders: sortedOrders,
    historyOrders: sortedOrders,
    orders: sortedOrders
  };
}

async function collectMemberOrderNos(env, phone, member) {
  const found = new Set();

  function add(no) {
    no = String(no || "").trim();
    if (no) found.add(no);
  }

  const candidates = memberPhoneCandidates(phone);

  for (const candidate of candidates) {
    const phonePrefix = "phone:" + candidate + ":";
    await listKeys(env, phonePrefix, 5000, key => add(key.name.replace(phonePrefix, "")));

    const markerPrefix = "member_ordered:" + candidate + ":";
    await listKeys(env, markerPrefix, 5000, key => add(key.name.replace(markerPrefix, "")));
  }

  if (Array.isArray(member.recentOrderNos)) {
    member.recentOrderNos.forEach(add);
  }

  if (member.lastOrderNo) add(member.lastOrderNo);

  // Fallback for old records where phone/member indexes were missing.
  await listKeys(env, "order:", 5000, async key => {
    const raw = await env.ORDERS.get(key.name);
    if (!raw) return;

    try {
      const order = JSON.parse(raw);
      const orderPhones = [
        normalizePhone(order.phone),
        normalizePhone(order.memberPhone),
        normalizePhone(order.submittedPhone)
      ].filter(Boolean);

      if (orderPhones.some(p => samePhoneForMemberLookup(p, phone))) {
        add(order.orderNo || key.name.replace("order:", ""));
      }
    } catch (_) {}
  });

  return Array.from(found);
}

async function listKeys(env, prefix, limit, callback) {
  let cursor = undefined;
  let count = 0;

  do {
    const page = await env.ORDERS.list({ prefix, cursor });

    for (const key of (page.keys || [])) {
      count += 1;
      await callback(key);
      if (count >= limit) return;
    }

    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);
}

function latestOrderTime(order) {
  return Math.max(
    new Date(order.statusUpdatedAt || 0).getTime() || 0,
    new Date(order.updatedAt || 0).getTime() || 0,
    new Date(order.cancelledAt || 0).getTime() || 0,
    new Date(order.pickedUpAt || 0).getTime() || 0,
    new Date(order.completedAt || 0).getTime() || 0,
    new Date(order.createdAt || 0).getTime() || 0
  );
}

function isCancelledOrder(order) {
  const s = String(order.status || "").toLowerCase();
  return s === "cancelled" || s === "canceled" || s.indexOf("cancel") >= 0;
}

function sortOrdersForMember(orders) {
  return (Array.isArray(orders) ? orders : []).slice().sort((a, b) => {
    const ac = isCancelledOrder(a) ? 1 : 0;
    const bc = isCancelledOrder(b) ? 1 : 0;
    if (ac !== bc) return ac - bc;

    const at = latestOrderTime(a);
    const bt = latestOrderTime(b);
    if (bt !== at) return bt - at;

    return String(b.orderNo || "").localeCompare(String(a.orderNo || ""));
  });
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
      { text: "🗑️ 刪除", callback_data: "member_delete:" + phone }
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
  if (phoneWithoutMacauCode(a) === phoneWithoutMacauCode(b)) return true;
  return false;
}

function memberPhoneCandidates(phone) {
  phone = normalizePhone(phone);
  const out = [];
  if (phone) out.push(phone);
  if (phone.length === 8) out.push("853" + phone);
  if (phone.length === 11 && phone.startsWith("853")) out.push(phone.slice(3));
  return Array.from(new Set(out.filter(Boolean)));
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


/* V192: membership reward helpers */
function sky31RewardTierV192(totalCups) {
  totalCups = Number(totalCups || 0);
  if (totalCups >= 180) return { key: "vip", name: "黑金會員", icon: "👑", next: null };
  if (totalCups >= 100) return { key: "diamond", name: "鑽石會員", icon: "💎", next: 180 };
  if (totalCups >= 60) return { key: "gold", name: "金卡會員", icon: "🥇", next: 100 };
  if (totalCups >= 30) return { key: "silver", name: "銀卡會員", icon: "🥈", next: 60 };
  return { key: "bronze", name: "青銅會員", icon: "☕", next: 30 };
}

function sky31RewardsFromMemberV192(member) {
  member = member || {};
  const totalCups = Number(member.totalCups || member.cups || member.totalItems || member.orderCups || 0);
  const redeemed = Number(member.rewardRedeemed || member.rewardsRedeemed || 0);
  const earned = Math.floor(totalCups / 10);
  const available = Math.max(0, earned - redeemed);
  const tier = sky31RewardTierV192(totalCups);
  return {
    totalCups,
    earnedRewards: earned,
    redeemedRewards: redeemed,
    availableRewards: available,
    cupsToNextReward: Math.max(0, 10 - (totalCups % 10 || 10)),
    rule: "每累計 10 杯，可免費兌換任何 1 杯飲品",
    tier
  };
}

function sky31DecorateMemberV192(member) {
  if (!member || typeof member !== "object") return member;
  const rewards = sky31RewardsFromMemberV192(member);
  member.rewards = rewards;
  member.availableRewards = rewards.availableRewards;
  member.memberTier = rewards.tier.name;
  member.memberTierIcon = rewards.tier.icon;
  member.memberTierKey = rewards.tier.key;
  return member;
}
