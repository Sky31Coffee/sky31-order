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
  return json({ ok: true, member: sky31DecorateMemberV196(withStats) });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    if (String(body.action || "") === "setBirthday") {
      const phoneForBirthday = normalizePhone(body.phone || "");
      const birthdayForMember = String(body.birthday || "").trim();

      if (!phoneForBirthday) return json({ ok: false, error: "請先登入會員" }, 400);
      if (!isValidBirthdayV211(birthdayForMember)) return json({ ok: false, error: "生日日期格式不正確" }, 400);

      const member = await loadMember(env, phoneForBirthday);
      if (!member) return json({ ok: false, error: "查詢不到會員資料" }, 404);
      if (member.birthday) return json({ ok: false, error: "生日已設定，如需更改請聯絡店員。" }, 409);

      const now = new Date().toISOString();
      member.birthday = birthdayForMember;
      member.birthdayLockedAt = now;
      member.birthdayUpdatedAt = now;
      member.birthdayUpdatedBy = "customer";
      member.updatedAt = now;

      await env.ORDERS.put("member:" + normalizePhone(member.phone || phoneForBirthday), JSON.stringify(member));

      const withStats = await enrichMemberWithOrders(env, member);
      return json({ ok: true, member: sky31DecorateMemberV196(withStats) });
    }

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

    return json({ ok: true, member: sky31DecorateMemberV196(withStats) });
  } catch (e) {
    return json({ ok: false, error: e.message || "保存會員失敗" }, 500);
  }
}

async function loadMember(env, phone) {
  phone = normalizePhone(phone);
  if (!phone) throw new Error("請輸入手機號碼");

  const matches = [];
  const seen = new Set();

  function add(key, member) {
    if (!member || member.deletedAt || seen.has(key)) return;
    const keyPhone = normalizePhone(String(key || "").replace(/^member:/, ""));
    const storedPhone = normalizePhone(member.phone || keyPhone);
    if (!samePhoneForMemberLookup(storedPhone, phone) && !samePhoneForMemberLookup(keyPhone, phone)) return;
    seen.add(key);
    member.phone = storedPhone || keyPhone || phone;
    matches.push({ key, member });
  }

  // V226 fast path: try exact/canonical phone candidates first.
  for (const candidate of memberPhoneCandidates(phone)) {
    const key = "member:" + candidate;
    const raw = await env.ORDERS.get(key);
    if (!raw) continue;
    try { add(key, JSON.parse(raw)); } catch (_) {}
  }

  // V226: only full-scan member:* if direct keys fail. This avoids slow login after duplicate cleanup.
  if (!matches.length) {
    let cursor = undefined;
    let checked = 0;
    do {
      const page = await env.ORDERS.list({ prefix: "member:", cursor });
      for (const key of (page.keys || [])) {
        checked += 1;
        if (checked > 5000) break;
        const raw = await env.ORDERS.get(key.name);
        if (!raw) continue;
        try { add(key.name, JSON.parse(raw)); } catch (_) {}
      }
      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor && checked <= 5000);
  }

  if (!matches.length) throw new Error("會員資料不存在或已被刪除，請重新登入或重新註冊");

  function manualKeyOf(member) {
    return String(member.manualTierKey || member.memberTierOverrideKey || member.memberTierManualKey || "").trim();
  }
  function timeOf(member) {
    return Math.max(
      new Date(member.manualTierUpdatedAt || 0).getTime() || 0,
      new Date(member.birthdayUpdatedAt || 0).getTime() || 0,
      new Date(member.updatedAt || 0).getTime() || 0,
      new Date(member.createdAt || 0).getTime() || 0
    );
  }

  matches.sort((a, b) => {
    const am = manualKeyOf(a.member) ? 1 : 0;
    const bm = manualKeyOf(b.member) ? 1 : 0;
    if (bm !== am) return bm - am;
    return timeOf(b.member) - timeOf(a.member);
  });

  const merged = { ...matches[matches.length - 1].member, ...matches[0].member };
  const manualSource = matches.find(x => manualKeyOf(x.member));
  if (manualSource) {
    merged.manualTierKey = manualSource.member.manualTierKey || manualSource.member.memberTierOverrideKey || manualSource.member.memberTierManualKey || "";
    merged.manualTierName = manualSource.member.manualTierName || manualSource.member.memberTierOverrideName || "";
    merged.manualTierIcon = manualSource.member.manualTierIcon || manualSource.member.memberTierOverrideIcon || "";
    merged.memberTierOverrideKey = merged.manualTierKey;
    merged.memberTierOverrideName = merged.manualTierName;
    merged.memberTierOverrideIcon = merged.manualTierIcon;
    merged.manualTierUpdatedAt = manualSource.member.manualTierUpdatedAt || "";
    merged.manualTierUpdatedBy = manualSource.member.manualTierUpdatedBy || "";
    merged.manualTierStartCups = Number(manualSource.member.manualTierStartCups ?? manualSource.member.manualTierSetAtCups ?? manualSource.member.manualTierOriginalCups ?? manualSource.member.totalCups ?? 0);
    merged.manualTierBaseCups = Number(manualSource.member.manualTierBaseCups || sky31TierThresholdV216(merged.manualTierKey));
  }

  for (const m of matches.map(x => x.member)) {
    merged.totalOrders = Math.max(Number(merged.totalOrders || 0), Number(m.totalOrders || 0));
    merged.totalCups = Math.max(Number(merged.totalCups || 0), Number(m.totalCups || 0));
    merged.totalSpent = Math.max(Number(merged.totalSpent || 0), Number(m.totalSpent || 0));
    merged.rewardRedeemed = Math.max(Number(merged.rewardRedeemed || merged.rewardsRedeemed || 0), Number(m.rewardRedeemed || m.rewardsRedeemed || 0));
    merged.rewardsRedeemed = merged.rewardRedeemed;
    if (!merged.birthday && m.birthday) merged.birthday = m.birthday;
  }

  return await enrichMemberWithOrders(env, merged);
}

async function enrichMemberWithOrders(env, member) {
  const phone = normalizePhone(member.phone);
  const orderNos = await collectMemberOrderNos(env, phone, member);

  const allOrders = [];
  let totalOrders = 0;
  let totalCups = 0;
  let totalSpent = 0;
  let redeemedRewards = 0;
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
    const cups = orderCups(order);
    const amount = Number(order.totalAmount || cartTotal(order.cart) || 0);
    const successful = isMemberLifetimeSuccessfulOrderV202(order);

    if (successful) {
      totalOrders += 1;
      totalCups += cups;
      totalSpent += amount;
      redeemedRewards += Math.max(0, Number(order.rewardUse || order.rewardUseRequested || 0));
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

  // V202: preserve existing lifetime counters and recover legacy completed/done/paid orders.
  // Newly created orders are still counted only after picked_up / successful transaction.
  const scannedTotalOrders = totalOrders;
  const scannedTotalCups = totalCups;
  const scannedTotalSpent = Math.round(totalSpent * 100) / 100;
  const scannedRewardRedeemed = redeemedRewards;

  const finalTotalOrders = Math.max(Number(member.totalOrders || 0), scannedTotalOrders);
  const finalTotalCups = Math.max(Number(member.totalCups || 0), scannedTotalCups);
  const finalTotalSpent = Math.max(Number(member.totalSpent || 0), scannedTotalSpent);
  const finalRewardRedeemed = Math.max(Number(member.rewardRedeemed || member.rewardsRedeemed || 0), scannedRewardRedeemed);

  const fixedMember = {
    ...member,
    phone,
    updatedAt: member.updatedAt || "",
    lastOrderAt: sortedOrders[0] ? (sortedOrders[0].updatedAt || sortedOrders[0].createdAt || "") : (member.lastOrderAt || ""),
    lastOrderNo: sortedOrders[0] ? sortedOrders[0].orderNo : (member.lastOrderNo || ""),
    totalOrders: finalTotalOrders,
    totalCups: finalTotalCups,
    totalSpent: Math.round(finalTotalSpent * 100) / 100,
    rewardRedeemed: finalRewardRedeemed,
    rewardsRedeemed: finalRewardRedeemed,
    recentOrderNos: sortedOrders.map(o => o.orderNo).filter(Boolean).slice(0, 2000)
  };

  // Repair stuck counters in KV when possible, so the account no longer stays
  // capped at the previous value such as 6 cups.
  try {
    if (
      Number(member.totalOrders || 0) !== fixedMember.totalOrders ||
      Number(member.totalCups || 0) !== fixedMember.totalCups ||
      Number(member.totalSpent || 0) !== fixedMember.totalSpent ||
      Number(member.rewardRedeemed || member.rewardsRedeemed || 0) !== Number(fixedMember.rewardRedeemed || 0) ||
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
    manualTierKey: fixedMember.manualTierKey || fixedMember.memberTierOverrideKey || fixedMember.memberTierManualKey || "",
    manualTierName: fixedMember.manualTierName || fixedMember.memberTierOverrideName || "",
    manualTierIcon: fixedMember.manualTierIcon || fixedMember.memberTierOverrideIcon || "",
    memberTierOverrideKey: fixedMember.memberTierOverrideKey || fixedMember.manualTierKey || "",
    memberTierOverrideName: fixedMember.memberTierOverrideName || fixedMember.manualTierName || "",
    memberTierOverrideIcon: fixedMember.memberTierOverrideIcon || fixedMember.manualTierIcon || "",
    manualTierUpdatedAt: fixedMember.manualTierUpdatedAt || "",
    manualTierUpdatedBy: fixedMember.manualTierUpdatedBy || "",
    manualTierStartCups: Number(fixedMember.manualTierStartCups ?? fixedMember.manualTierSetAtCups ?? fixedMember.manualTierOriginalCups ?? fixedMember.totalCups ?? 0),
    manualTierBaseCups: Number(fixedMember.manualTierBaseCups || sky31TierThresholdV216(fixedMember.manualTierKey || fixedMember.memberTierOverrideKey || fixedMember.memberTierManualKey || "")),
    birthdayLockedAt: fixedMember.birthdayLockedAt || "",
    birthdayUpdatedAt: fixedMember.birthdayUpdatedAt || "",
    birthdayUpdatedBy: fixedMember.birthdayUpdatedBy || "",
    rewardRedeemed: Number(fixedMember.rewardRedeemed || 0),
    rewardsRedeemed: Number(fixedMember.rewardRedeemed || 0),
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

  // V226: Full order:* scan is expensive and made login slow as orders grew.
  // Use it only when no phone index / member_ordered index / recentOrderNos exists.
  if (!found.size) {
    await listKeys(env, "order:", 1200, async key => {
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
  }

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
  // V237: support old records accidentally saved with 853 prefix of any length.
  if (phone.length > 3 && phone.startsWith("853")) return phone.slice(3);
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
  return { key: "regular", name: "普通會員", icon: "🌱", next: 30 };
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
    rule: "成功領取累計 10 杯，可免費兌換任何 1 杯飲品",
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


/* V196: force /api/member to return visible reward stats */
function sky31RewardTierV196(totalCups) {
  totalCups = Number(totalCups || 0);
  if (totalCups >= 180) return { key: "vip", name: "黑金會員", icon: "👑", next: null };
  if (totalCups >= 100) return { key: "diamond", name: "鑽石會員", icon: "💎", next: 180 };
  if (totalCups >= 60) return { key: "gold", name: "金卡會員", icon: "🥇", next: 100 };
  if (totalCups >= 30) return { key: "silver", name: "銀卡會員", icon: "🥈", next: 60 };
  return { key: "regular", name: "普通會員", icon: "🌱", next: 30 };
}

function sky31RewardsFromMemberV196(member) {
  member = member || {};
  const totalCups = Number(member.totalCups || member.cups || member.totalItems || member.orderCups || 0);
  const redeemed = Number(member.rewardRedeemed || member.rewardsRedeemed || 0);
  const earned = Math.floor(totalCups / 10);
  const available = Math.max(0, earned - redeemed);
  const progress = totalCups % 10;
  const cupsToNextReward = progress === 0 && totalCups > 0 ? 0 : 10 - progress;
  const tier = sky31RewardTierV196(totalCups);
  return {
    totalCups,
    earnedRewards: earned,
    redeemedRewards: redeemed,
    availableRewards: available,
    cupsToNextReward,
    nextRewardAt: (earned + 1) * 10,
    rule: "成功領取累計 10 杯，可免費兌換任何 1 杯飲品",
    tier
  };
}

function sky31DecorateMemberV196(member) {
  if (!member || typeof member !== "object") return member;
  const rewards = sky31RewardsFromMemberV196(member);
  const displayTier = sky31DisplayTierV216(member, rewards.tier);
  const manualTier = displayTier.manualBase;
  return {
    ...member,
    manualTierKey: member.manualTierKey || member.memberTierOverrideKey || member.memberTierManualKey || "",
    manualTierName: member.manualTierName || member.memberTierOverrideName || (manualTier && manualTier.name) || "",
    manualTierIcon: member.manualTierIcon || member.memberTierOverrideIcon || (manualTier && manualTier.icon) || "",
    manualTierBaseCups: Number(member.manualTierBaseCups || (manualTier ? sky31TierThresholdV216(manualTier.key) : 0)),
    manualTierStartCups: Number(member.manualTierStartCups || member.manualTierSetAtCups || member.manualTierOriginalCups || member.totalCups || member.cups || 0),
    memberTierOverrideKey: member.memberTierOverrideKey || member.manualTierKey || "",
    memberTierOverrideName: member.memberTierOverrideName || member.manualTierName || "",
    memberTierOverrideIcon: member.memberTierOverrideIcon || member.manualTierIcon || "",
    rewardRedeemed: rewards.redeemedRewards,
    rewards,
    availableRewards: rewards.availableRewards,
    earnedRewards: rewards.earnedRewards,
    redeemedRewards: rewards.redeemedRewards,
    cupsToNextReward: rewards.cupsToNextReward,
    naturalMemberTier: rewards.tier.name,
    naturalMemberTierIcon: rewards.tier.icon,
    naturalMemberTierKey: rewards.tier.key,
    memberTier: displayTier.name,
    memberTierIcon: displayTier.icon,
    memberTierKey: displayTier.key,
    memberTierManual: !!displayTier.manual,
    memberTierManualBase: displayTier.manualBase ? displayTier.manualBase.name : "",
    memberTierEffectiveCups: displayTier.effectiveCups,
    memberTierCupsToNext: displayTier.cupsToNext,
    memberTierGainedSinceManual: displayTier.gainedSinceManualTier || 0,
    birthdayVoucherCount: sky31BirthdayVoucherCountV217(member),
    drinkVoucherCount: Number(rewards.availableRewards || 0) + sky31BirthdayVoucherCountV217(member)
  };
}


/* V199: successful member lifetime stats only count picked_up orders. */
function isSuccessfulPickedUpOrderV199(order) {
  return isMemberLifetimeSuccessfulOrderV202(order);
}

function isMemberLifetimeSuccessfulOrderV202(order) {
  if (!order) return false;
  if (isCancelledOrder(order)) return false;

  const s = String(order.status || "").toLowerCase().replace(/[\s-]+/g, "_");
  const positiveStatuses = new Set([
    "picked_up",
    "pickedup",
    "completed",
    "complete",
    "done",
    "finished",
    "fulfilled",
    "paid",
    "paid_success",
    "success",
    "successful"
  ]);

  if (positiveStatuses.has(s)) return true;

  if (order.pickedUpAt || order.completedAt || order.paidAt || order.paymentAt) return true;

  const pay = String(order.paymentStatus || order.payStatus || "").toLowerCase();
  if (pay === "paid" || pay === "success" || pay === "successful") return true;

  return false;
}


/* V211: birthday validation and manual tier override for member API. */
function isValidBirthdayV211(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day === s;
}

function sky31TierByKeyV211(key) {
  key = String(key || "").toLowerCase();
  if (key === "vip") key = "blackgold";
  const map = {
    regular: { key: "regular", name: "普通會員", icon: "🌱", next: 30 },
    silver: { key: "silver", name: "銀卡會員", icon: "🥈", next: 60 },
    gold: { key: "gold", name: "金卡會員", icon: "🥇", next: 100 },
    diamond: { key: "diamond", name: "鑽石會員", icon: "💎", next: 180 },
    blackgold: { key: "blackgold", name: "黑金會員", icon: "👑", next: null }
  };
  return map[key] || null;
}


function sky31TierThresholdV216(key) {
  key = String(key || "").toLowerCase();
  if (key === "vip") key = "blackgold";
  const map = { regular: 0, silver: 30, gold: 60, diamond: 100, blackgold: 180 };
  return map[key] == null ? 0 : map[key];
}

function sky31TierByCupsV216(cups) {
  cups = Number(cups || 0);
  if (cups >= 180) return sky31TierByKeyV211("blackgold");
  if (cups >= 100) return sky31TierByKeyV211("diamond");
  if (cups >= 60) return sky31TierByKeyV211("gold");
  if (cups >= 30) return sky31TierByKeyV211("silver");
  return sky31TierByKeyV211("regular");
}

function sky31DisplayTierV216(member, naturalTier) {
  member = member || {};
  const totalCups = Number(member.totalCups || member.cups || member.totalItems || 0);
  const manualBase = sky31TierByKeyV211(member.manualTierKey || member.memberTierOverrideKey || member.memberTierManualKey || "");

  if (!manualBase) {
    const tier = naturalTier || sky31TierByCupsV216(totalCups);
    return { ...tier, manual: false, effectiveCups: totalCups, manualBase: null, cupsToNext: tier.next ? Math.max(0, tier.next - totalCups) : 0 };
  }

  const baseCups = Number(member.manualTierBaseCups || sky31TierThresholdV216(manualBase.key));
  const hasStart = member.manualTierStartCups != null || member.manualTierSetAtCups != null || member.manualTierOriginalCups != null;
  const startCups = hasStart ? Number(member.manualTierStartCups ?? member.manualTierSetAtCups ?? member.manualTierOriginalCups ?? 0) : null;
  const gained = hasStart ? Math.max(0, totalCups - Number(startCups || 0)) : 0;
  const effectiveCups = hasStart ? (baseCups + gained) : Math.max(totalCups, baseCups);
  const tier = sky31TierByCupsV216(effectiveCups);
  const next = tier.next == null ? null : tier.next;

  return {
    ...tier,
    manual: true,
    manualBase,
    manualBaseCups: baseCups,
    manualStartCups: hasStart ? Number(startCups || 0) : totalCups,
    gainedSinceManualTier: hasStart ? gained : Math.max(0, totalCups - baseCups),
    effectiveCups,
    cupsToNext: next == null ? 0 : Math.max(0, next - effectiveCups)
  };
}

function sky31BirthdayVoucherCountV217(member) {
  const birthday = String((member && member.birthday) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return 0;
  const month = Number(birthday.split("-")[1] || 0);
  const now = new Date();
  return month === now.getUTCMonth() + 1 ? 1 : 0;
}
