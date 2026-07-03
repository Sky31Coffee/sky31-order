

function normalizeBirthdayV265(value) {
  let s = String(value || "").trim();
  if (!s) return "";
  s = s.replace(/[．。]/g, ".")
       .replace(/[\/\.]/g, "-")
       .replace(/年/g, "-")
       .replace(/月/g, "-")
       .replace(/日/g, "")
       .replace(/\s+/g, "");
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compact) m = compact;
  }
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) return "";
  return String(y).padStart(4, "0") + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

function formatMemberNameV265(name) {
  name = String(name || "").trim().replace(/\s+/g, " ");
  if (!name) return "";
  return name.replace(/\b([a-zA-Z])([a-zA-Z'’-]*)\b/g, function(_, first, rest) {
    return first.toUpperCase() + String(rest || "");
  });
}

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


function memberRegistrationPurgeKeysV261(phone) {
  phone = normalizePhone(phone || "");
  const out = new Set();
  if (!phone) return [];
  const last = phone.length >= 8 ? phone.slice(-8) : phone;

  out.add("member_deleted:" + phone);
  out.add("member_purged:" + phone);
  if (last) {
    out.add("member_tier_override:" + last);
    out.add("member_purged:last8:" + last);
  }

  // Clean existing legacy blocks only; this does not create or normalize any 853 member.
  if (phone.length === 8) {
    out.add("member:" + "853" + phone);
    out.add("member_deleted:" + "853" + phone);
    out.add("member_purged:" + "853" + phone);
  }
  if (phone.length > 3 && phone.startsWith("853")) {
    const local = phone.slice(3);
    out.add("member:" + local);
    out.add("member_deleted:" + local);
    out.add("member_purged:" + local);
    out.add("member_tier_override:" + local.slice(-8));
    out.add("member_purged:last8:" + local.slice(-8));
  }

  return Array.from(out).filter(Boolean);
}

async function clearMemberRegistrationBlocksV261(env, phone) {
  if (!env || !env.ORDERS) return;
  for (const key of memberRegistrationPurgeKeysV261(phone)) {
    try { await env.ORDERS.delete(key); } catch (_) {}
  }
}


function memberLast8V262(phone) {
  const p = normalizePhone(phone || "");
  return p.length >= 8 ? p.slice(-8) : p;
}

function memberTierOverrideKeyV262(phone) {
  const last = memberLast8V262(phone);
  return last ? "member_tier_override:" + last : "";
}

async function readMemberTierOverrideV262(env, phone) {
  const key = memberTierOverrideKeyV262(phone);
  if (!key || !env || !env.ORDERS) return null;
  const raw = await env.ORDERS.get(key);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || !(data.manualTierKey || data.memberTierOverrideKey || data.memberTierManualKey)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function applyMemberTierOverrideV262(member, override) {
  if (!member || !override) return member;
  const tierKey = override.manualTierKey || override.memberTierOverrideKey || override.memberTierManualKey || "";
  if (!tierKey) return member;
  const out = { ...member };
  out.manualTierKey = tierKey;
  out.manualTierName = override.manualTierName || override.memberTierOverrideName || out.manualTierName || "";
  out.manualTierIcon = override.manualTierIcon || override.memberTierOverrideIcon || out.manualTierIcon || "";
  out.memberTierOverrideKey = tierKey;
  out.memberTierOverrideName = out.manualTierName;
  out.memberTierOverrideIcon = out.manualTierIcon;
  out.manualTierBaseCups = Number(override.manualTierBaseCups ?? out.manualTierBaseCups ?? sky31TierThresholdV216(tierKey));
  out.manualTierStartCups = Number(override.manualTierStartCups ?? override.manualTierSetAtCups ?? override.manualTierOriginalCups ?? out.manualTierStartCups ?? out.totalCups ?? 0);
  out.manualTierSetAtCups = out.manualTierStartCups;
  out.manualTierOriginalCups = out.manualTierStartCups;
  out.manualTierUpdatedAt = override.manualTierUpdatedAt || out.manualTierUpdatedAt || out.updatedAt || "";
  out.manualTierUpdatedBy = override.manualTierUpdatedBy || out.manualTierUpdatedBy || "telegram";
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    if (String(body.action || "") === "setBirthday") {
      const phoneForBirthday = normalizePhone(body.phone || "");
      const birthdayForMember = normalizeBirthdayV265(body.birthday || "");

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

      await env.ORDERS.put("member:" + phoneForBirthday, JSON.stringify(member), { expirationTtl: 60 * 60 * 24 * 3650 });

      const withStats = await enrichMemberWithOrders(env, member);
      return json({ ok: true, member: sky31DecorateMemberV196(withStats) });
    }

    const phone = normalizePhone(body.phone || "");
    const name = formatMemberNameV265(body.name || body.customerName || "");
    const birthday = normalizeBirthdayV265(body.birthday || "");
    const note = String(body.note || "").trim();

    if (!phone || !name || !birthday) {
      return json({ ok: false, error: "請輸入姓名、手機號碼和生日" }, 400);
    }

    let existing = null;
    try { existing = await loadMember(env, phone); } catch (_) { existing = null; }
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

    await clearMemberRegistrationBlocksV261(env, phone);
    try { const oldTierKey = memberTierOverrideKeyV262(phone); if (oldTierKey) await env.ORDERS.delete(oldTierKey); } catch (_) {}
    await env.ORDERS.put("member:" + phone, JSON.stringify(member), { expirationTtl: 60 * 60 * 24 * 3650 });

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

  const raw = await env.ORDERS.get("member:" + phone);
  if (!raw) throw new Error("會員資料不存在或已被刪除，請重新登入或重新註冊");

  let member = null;
  try { member = JSON.parse(raw); } catch (_) { member = null; }
  if (!member || member.deletedAt) throw new Error("會員資料不存在或已被刪除，請重新登入或重新註冊");

  member.phone = normalizePhone(member.phone || phone) || phone;
  if (member.phone !== phone) member.phone = phone;

  const override = await readMemberTierOverrideV262(env, phone);
  return await enrichMemberWithOrders(env, applyMemberTierOverrideV262(member, override));
}




/* V272: keep immediate order-submit voucher locks until the related order appears in KV list. */
function memberRewardLockMapV272(member) {
  const raw = member && member.voucherReservationLocks;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function memberActiveVoucherLocksV272(member, knownOrderNos) {
  const locks = memberRewardLockMapV272(member);
  const out = {};
  const known = knownOrderNos instanceof Set ? knownOrderNos : new Set();
  const now = Date.now();
  const maxAgeMs = 1000 * 60 * 60 * 24 * 3;
  Object.keys(locks).forEach(no => {
    const lock = locks[no] || {};
    const created = new Date(lock.createdAt || 0).getTime() || 0;
    if (known.has(String(no))) return;
    if (created && now - created > maxAgeMs) return;
    out[no] = {
      orderNo: String(no),
      rewardEarnedUse: Math.max(0, Number(lock.rewardEarnedUse || lock.earned || 0)),
      rewardGiftUse: Math.max(0, Number(lock.rewardGiftUse || lock.gift || 0)),
      rewardBirthdayUse: Math.max(0, Number(lock.rewardBirthdayUse || lock.birthday || 0)),
      birthdayVoucherMonthKey: String(lock.birthdayVoucherMonthKey || ""),
      createdAt: String(lock.createdAt || "")
    };
  });
  return out;
}


function memberRewardNormalUseFromOrderV270(order) {
  if (!order) return 0;
  if (order.rewardNormalUse != null) return Math.max(0, Number(order.rewardNormalUse || 0));
  if (order.rewardBirthdayUse != null) return Math.max(0, Number(order.rewardUse || order.rewardUseRequested || 0) - Number(order.rewardBirthdayUse || 0));
  return Math.max(0, Number(order.rewardUse || order.rewardUseRequested || 0));
}

function memberRewardGiftUseFromOrderV270(order) {
  if (!order) return 0;
  return Math.max(0, Number(order.rewardGiftUse || 0));
}

function memberRewardEarnedUseFromOrderV270(order) {
  if (!order) return 0;
  if (order.rewardEarnedUse != null) return Math.max(0, Number(order.rewardEarnedUse || 0));
  return Math.max(0, memberRewardNormalUseFromOrderV270(order) - memberRewardGiftUseFromOrderV270(order));
}


function memberBirthdayVoucherMonthKeyV266(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  const ok = !Number.isNaN(d.getTime());
  const x = ok ? d : new Date();
  return x.getUTCFullYear() + "-" + String(x.getUTCMonth() + 1).padStart(2, "0");
}

function memberRewardNormalUseFromOrderV266(order) {
  return memberRewardEarnedUseFromOrderV270(order);
}

function memberRewardBirthdayUseFromOrderV266(order, monthKey) {
  if (!order) return 0;
  const use = Math.max(0, Number(order.rewardBirthdayUse || order.birthdayVoucherCount || 0));
  if (!use) return 0;
  const key = String(order.birthdayVoucherMonthKey || memberBirthdayVoucherMonthKeyV266(order.createdAt || order.updatedAt || order.statusUpdatedAt || ""));
  return !monthKey || key === monthKey ? use : 0;
}

function memberBirthdayVoucherUsedOrReservedV266(member) {
  member = member || {};
  return Math.max(0, Number(member.birthdayVoucherRedeemedThisMonth || 0)) +
         Math.max(0, Number(member.birthdayVoucherReservedThisMonth || 0));
}


async function enrichMemberWithOrders(env, member) {
  const phone = normalizePhone(member.phone);
  const orderNos = await collectMemberOrderNos(env, phone, member);

  const allOrders = [];
  let totalOrders = 0;
  let totalCups = 0;
  let totalSpent = 0;
  let redeemedRewards = 0;
  let reservedRewards = 0;
  let giftVoucherRedeemed = 0;
  let giftVoucherReserved = 0;
  let redeemedFreeCupsTotalV279 = 0;
  let birthdayVoucherRedeemedThisMonth = 0;
  let birthdayVoucherReservedThisMonth = 0;
  const currentBirthdayMonthKey = memberBirthdayVoucherMonthKeyV266(new Date());
  const seenOrderNosV272 = new Set();
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
    seenOrderNosV272.add(String(order.orderNo || no));
    const orderCupCountV278 = orderCups(order);
    const voucherCupCountV278 = memberVoucherUseCountV275(order);
    const cups = memberLoyaltyCupsV275(order);
    const amount = Number(order.totalAmount || cartTotal(order.cart) || 0);
    const successful = isMemberLifetimeSuccessfulOrderV202(order);

    const normalRewardUse = memberRewardEarnedUseFromOrderV270(order);
    const giftRewardUse = memberRewardGiftUseFromOrderV270(order);
    const birthdayRewardUse = memberRewardBirthdayUseFromOrderV266(order, currentBirthdayMonthKey);

    if (successful) {
      totalOrders += 1;
      totalCups += cups;
      totalSpent += amount;
      redeemedRewards += normalRewardUse;
      giftVoucherRedeemed += giftRewardUse;
      redeemedFreeCupsTotalV279 += voucherCupCountV278;
      birthdayVoucherRedeemedThisMonth += birthdayRewardUse;
    } else if (!isCancelledOrder(order)) {
      reservedRewards += normalRewardUse;
      giftVoucherReserved += giftRewardUse;
      birthdayVoucherReservedThisMonth += birthdayRewardUse;
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
      totalCups: orderCupCountV278,
      orderCups: orderCupCountV278,
      totalOrderCups: orderCupCountV278,
      loyaltyCups: cups,
      paidCups: cups,
      accumulatedCups: cups,
      redeemedFreeCups: voucherCupCountV278,
      freeRedeemedCups: voucherCupCountV278,
      voucherCups: voucherCupCountV278,
      subtotalBeforeReward: Number(order.subtotalBeforeReward || order.totalBeforeTierDiscount || 0),
      totalBeforeTierDiscount: Number(order.totalBeforeTierDiscount || order.subtotalBeforeReward || 0),
      totalAfterTierDiscount: Number(order.totalAfterTierDiscount || 0),
      memberTierKey: order.memberTierKey || "",
      memberTierName: order.memberTierName || "",
      memberTierIcon: order.memberTierIcon || "",
      tierDiscount: Number(order.tierDiscount || 0),
      tierDiscountDetails: Array.isArray(order.tierDiscountDetails) ? order.tierDiscountDetails : [],
      rewardUse: Number(order.rewardUse || order.rewardUseRequested || 0),
      rewardDiscount: Number(order.rewardDiscount || 0),
      rewardFreeItems: Array.isArray(order.rewardFreeItems) ? order.rewardFreeItems : [],
      birthdayVoucherCount: Number(order.birthdayVoucherCount || 0),
      discountCalculationOrder: order.discountCalculationOrder || "",
      totalAmount: Math.round(amount * 100) / 100,
      currency: order.currency || "MOP",
      cart: normalizeCart(order.cart, order.currency || "MOP")
    });
  }

  const sortedOrders = sortOrdersForMember(allOrders);

  // V202: preserve existing lifetime counters and recover legacy completed/done/paid orders.
  // Newly created orders are still counted only after picked_up / successful transaction.
  const extraLocksV272 = memberActiveVoucherLocksV272(member, seenOrderNosV272);
  Object.keys(extraLocksV272).forEach(no => {
    const lock = extraLocksV272[no] || {};
    reservedRewards += Math.max(0, Number(lock.rewardEarnedUse || 0));
    giftVoucherReserved += Math.max(0, Number(lock.rewardGiftUse || 0));
    const lockMonth = String(lock.birthdayVoucherMonthKey || currentBirthdayMonthKey);
    if (lockMonth === currentBirthdayMonthKey) birthdayVoucherReservedThisMonth += Math.max(0, Number(lock.rewardBirthdayUse || 0));
  });

  const scannedTotalOrders = totalOrders;
  const scannedTotalCups = totalCups;
  const scannedTotalSpent = Math.round(totalSpent * 100) / 100;
  const scannedRewardRedeemed = redeemedRewards;
  const scannedRewardReserved = reservedRewards;
  const scannedGiftVoucherReserved = giftVoucherReserved;

  // V239: use exact recomputed values, not Math.max(old, scanned).
  // Math.max prevented cups/free-drink counts from decreasing after undo pickup or cancel.
  const finalTotalOrders = scannedTotalOrders;
  const finalTotalCups = scannedTotalCups;
  const finalTotalSpent = scannedTotalSpent;
  const finalRewardRedeemed = scannedRewardRedeemed;

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
    giftVoucherRedeemed,
    giftVoucherUsed: giftVoucherRedeemed,
    rewardReserved: scannedRewardReserved,
    rewardsReserved: scannedRewardReserved,
    giftVoucherReserved: scannedGiftVoucherReserved,
    voucherReservationLocks: extraLocksV272,
    giftVoucherReservedRewards: scannedGiftVoucherReserved,
    redeemedFreeCups: redeemedFreeCupsTotalV279,
    successfulFreeCups: redeemedFreeCupsTotalV279,
    birthdayVoucherRedeemedThisMonth,
    birthdayVoucherReservedThisMonth,
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
      Number(member.rewardReserved || member.rewardsReserved || 0) !== Number(fixedMember.rewardReserved || 0) ||
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
    manualTierBaseCups: Number(fixedMember.manualTierBaseCups ?? sky31TierThresholdV216(fixedMember.manualTierKey || fixedMember.memberTierOverrideKey || fixedMember.memberTierManualKey || "")),
    birthdayLockedAt: fixedMember.birthdayLockedAt || "",
    birthdayUpdatedAt: fixedMember.birthdayUpdatedAt || "",
    birthdayUpdatedBy: fixedMember.birthdayUpdatedBy || "",
    rewardRedeemed: Number(fixedMember.rewardRedeemed || 0),
    rewardsRedeemed: Number(fixedMember.rewardRedeemed || 0),
    giftVoucherBalance: Math.max(0, Number(fixedMember.giftVoucherBalance || fixedMember.giftVouchers || fixedMember.manualGiftVouchers || 0)),
    giftVoucherRedeemed: Number(fixedMember.giftVoucherRedeemed || fixedMember.giftVoucherUsed || 0),
    giftVoucherUsed: Number(fixedMember.giftVoucherRedeemed || fixedMember.giftVoucherUsed || 0),
    giftVoucherUpdatedAt: fixedMember.giftVoucherUpdatedAt || "",
    giftVoucherUpdatedBy: fixedMember.giftVoucherUpdatedBy || "",
    giftVoucherReserved: Number(fixedMember.giftVoucherReserved || fixedMember.giftVoucherReservedRewards || 0),
    giftVoucherReservedRewards: Number(fixedMember.giftVoucherReserved || fixedMember.giftVoucherReservedRewards || 0),
    rewardReserved: Number(fixedMember.rewardReserved || fixedMember.rewardsReserved || 0),
    rewardsReserved: Number(fixedMember.rewardReserved || fixedMember.rewardsReserved || 0),
    birthdayVoucherRedeemedThisMonth: Number(fixedMember.birthdayVoucherRedeemedThisMonth || 0),
    birthdayVoucherReservedThisMonth: Number(fixedMember.birthdayVoucherReservedThisMonth || 0),
    redeemedFreeCups: Number(fixedMember.redeemedFreeCups || fixedMember.successfulFreeCups || 0),
    successfulFreeCups: Number(fixedMember.successfulFreeCups || fixedMember.redeemedFreeCups || 0),
    loyaltyCups: Number(fixedMember.totalCups || 0),
    paidCups: Number(fixedMember.totalCups || 0),
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
  return phone ? [phone] : [];
}


function memberVoucherUseCountV275(order) {
  if (!order) return 0;
  const rewardUse = Math.max(0, Number(order.rewardUse || order.rewardUseRequested || 0));
  const birthdayUse = Math.max(0, Number(order.rewardBirthdayUse || order.birthdayVoucherCount || 0));
  const normalUse = Math.max(0, Number(order.rewardNormalUse || 0));
  const giftUse = Math.max(0, Number(order.rewardGiftUse || 0));
  const earnedUse = Math.max(0, Number(order.rewardEarnedUse || 0));
  return Math.max(rewardUse, normalUse + birthdayUse, giftUse + earnedUse + birthdayUse);
}

function memberLoyaltyCupsV275(order) {
  return Math.max(0, orderCups(order) - memberVoucherUseCountV275(order));
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
  const reserved = Number(member.rewardReserved || member.rewardsReserved || member.pendingRewardUse || 0);
  const rawGifted = Math.max(0, Number(member.giftVoucherBalance || member.giftVouchers || member.manualGiftVouchers || 0));
  const giftRedeemed = Math.max(0, Number(member.giftVoucherRedeemed || member.giftVoucherUsed || 0));
  const giftReserved = Math.max(0, Number(member.giftVoucherReserved || member.giftVoucherReservedRewards || 0));
  const gifted = Math.max(rawGifted, giftRedeemed + giftReserved);
  const giftAvailable = Math.max(0, gifted - giftRedeemed - giftReserved);
  const earned = Math.floor(totalCups / 10);
  const earnedAvailable = Math.max(0, earned - redeemed - reserved);
  const available = Math.max(0, earnedAvailable + giftAvailable);
  const tier = sky31RewardTierV192(totalCups);
  return {
    totalCups,
    earnedRewards: earned,
    giftedRewards: gifted,
    giftVoucherBalance: gifted,
    giftVoucherRedeemed: giftRedeemed,
    giftVoucherUsed: giftRedeemed,
    giftVoucherReserved: giftReserved,
    giftVoucherAvailableRewards: giftAvailable,
    redeemedRewards: redeemed,
    reservedRewards: reserved,
    availableRewards: available,
    cupsToNextReward: Math.max(0, 10 - (totalCups % 10 || 10)),
    rule: "實付累計 10 杯，可獲得 1 張餐品券",
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
  const reserved = Number(member.rewardReserved || member.rewardsReserved || member.pendingRewardUse || 0);
  const rawGifted = Math.max(0, Number(member.giftVoucherBalance || member.giftVouchers || member.manualGiftVouchers || 0));
  const giftRedeemed = Math.max(0, Number(member.giftVoucherRedeemed || member.giftVoucherUsed || 0));
  const giftReserved = Math.max(0, Number(member.giftVoucherReserved || member.giftVoucherReservedRewards || 0));
  const gifted = Math.max(rawGifted, giftRedeemed + giftReserved);
  const giftAvailable = Math.max(0, gifted - giftRedeemed - giftReserved);
  const earned = Math.floor(totalCups / 10);
  const earnedAvailable = Math.max(0, earned - redeemed - reserved);
  const available = Math.max(0, earnedAvailable + giftAvailable);
  const progress = totalCups % 10;
  const cupsToNextReward = progress === 0 && totalCups > 0 ? 0 : 10 - progress;
  const tier = sky31RewardTierV196(totalCups);
  return {
    totalCups,
    earnedRewards: earned,
    giftedRewards: gifted,
    giftVoucherBalance: gifted,
    giftVoucherRedeemed: giftRedeemed,
    giftVoucherUsed: giftRedeemed,
    giftVoucherReserved: giftReserved,
    giftVoucherAvailableRewards: giftAvailable,
    redeemedRewards: redeemed,
    reservedRewards: reserved,
    availableRewards: available,
    cupsToNextReward,
    nextRewardAt: (earned + 1) * 10,
    rule: "實付累計 10 杯，可獲得 1 張餐品券",
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
    manualTierBaseCups: Number(member.manualTierBaseCups ?? (manualTier ? sky31TierThresholdV216(manualTier.key) : 0)),
    manualTierStartCups: Number(member.manualTierStartCups ?? member.manualTierSetAtCups ?? member.manualTierOriginalCups ?? member.totalCups ?? member.cups ?? 0),
    memberTierOverrideKey: member.memberTierOverrideKey || member.manualTierKey || "",
    memberTierOverrideName: member.memberTierOverrideName || member.manualTierName || "",
    memberTierOverrideIcon: member.memberTierOverrideIcon || member.manualTierIcon || "",
    rewardRedeemed: rewards.redeemedRewards,
    rewards,
    availableRewards: rewards.availableRewards,
    earnedRewards: rewards.earnedRewards,
    giftVoucherBalance: rewards.giftVoucherBalance,
    giftVoucherRedeemed: rewards.giftVoucherRedeemed,
    giftVoucherUsed: rewards.giftVoucherUsed,
    giftVoucherReserved: rewards.giftVoucherReserved,
    giftVoucherAvailableRewards: rewards.giftVoucherAvailableRewards,
    giftedRewards: rewards.giftedRewards,
    redeemedRewards: rewards.redeemedRewards,
    reservedRewards: rewards.reservedRewards,
    rewardReserved: rewards.reservedRewards,
    rewardsReserved: rewards.reservedRewards,
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
  // V239: Lifetime cups / free-drink vouchers must follow the real shop action:
  // only Telegram "已領取" orders count. Undo pickup or cancel should immediately
  // deduct the cups and the redeemed voucher count.
  if (!order) return false;
  if (isCancelledOrder(order)) return false;

  const s = String(order.status || "").toLowerCase().replace(/[\s-]+/g, "_");
  return s === "picked_up" || s === "pickedup";
}


/* V211: birthday validation and manual tier override for member API. */
function isValidBirthdayV211(value) {
  return !!normalizeBirthdayV265(value);
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

  const baseCups = Number(member.manualTierBaseCups ?? sky31TierThresholdV216(manualBase.key));
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
  member = member || {};
  const birthday = String(member.birthday || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return 0;

  const tier = sky31DisplayTierV216(member, null);
  const key = String((tier && tier.key) || member.memberTierKey || member.manualTierKey || "").toLowerCase();
  const goldOrAbove = key === "gold" || key === "diamond" || key === "blackgold" || key === "vip";
  if (!goldOrAbove) return 0;

  if (memberBirthdayVoucherUsedOrReservedV266(member) > 0) return 0;

  const month = Number(birthday.split("-")[1] || 0);
  const now = new Date();
  return month === now.getUTCMonth() + 1 ? 1 : 0;
}
