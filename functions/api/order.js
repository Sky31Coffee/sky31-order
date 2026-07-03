
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

    
    const sky31MemberForRewardV192 = await sky31LoadMemberForRewardV192(context.env || env, phone || body.phone || body.customerPhone || (body.member && body.member.phone));
    const sky31RewardInfoV192 = sky31RewardsFromMemberV192(sky31MemberForRewardV192 || {});
    const birthdayVoucherCountV217 = sky31BirthdayVoucherCountOrderV217(activeMember || sky31MemberForRewardV192 || {});
if (!cart.length && !String(body.orderText || "").trim()) {
      return json({ ok: false, error: "請先選擇飲品" }, 400);
    }

    const orderNo = await nextOrderNo(env);
    const createdAt = new Date();
    const pickup = body.pickup || getPickupFromCart(cart) || "Now 即取";
    const pickupTime = resolvePickupTime(pickup, createdAt);
    const sky31DiscountCalcV240 = sky31CalculateOrderDiscountsV240(
      activeMember,
      cart,
      Number(sky31RewardInfoV192.availableRewards || 0) + birthdayVoucherCountV217
    );
    const subtotalBeforeRewardV199 = sky31DiscountCalcV240.subtotal;
    const tierDiscountCalcV213 = sky31DiscountCalcV240.tierCalc;
    const tierDiscountV213 = sky31DiscountCalcV240.tierDiscount;
    const totalAfterTierV213 = sky31DiscountCalcV240.totalAfterTier;
    const rewardUseV199 = sky31DiscountCalcV240.rewardUse;
    const rewardBirthdayUseV266 = Math.min(Number(birthdayVoucherCountV217 || 0), Number(rewardUseV199 || 0));
    const rewardNormalUseV266 = Math.max(0, Number(rewardUseV199 || 0) - rewardBirthdayUseV266);
    const rewardDiscountV199 = sky31DiscountCalcV240.rewardDiscount;
    const rewardFreeItemsV199 = sky31DiscountCalcV240.rewardFreeItems;
    const totalAfterTierAndRewardV240 = sky31DiscountCalcV240.totalAmount;


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
      subtotalBeforeReward: subtotalBeforeRewardV199,
      rewardUse: rewardUseV199,
      rewardNormalUse: rewardNormalUseV266,
      rewardBirthdayUse: rewardBirthdayUseV266,
      rewardDiscount: rewardDiscountV199,
      rewardFreeItems: rewardFreeItemsV199,
      birthdayVoucherCount: rewardBirthdayUseV266 || 0,
      birthdayVoucherMonthKey: birthdayVoucherMonthKeyV266(createdAt),
      memberTierKey: tierDiscountCalcV213.tier.key,
      memberTierName: tierDiscountCalcV213.tier.name,
      memberTierIcon: tierDiscountCalcV213.tier.icon,
      memberTierManual: !!tierDiscountCalcV213.tier.manual,
      tierDiscount: tierDiscountV213,
      tierDiscountDetails: tierDiscountCalcV213.details,
      discountCalculationOrder: "tier_first_reward_after",
      totalBeforeTierDiscount: subtotalBeforeRewardV199,
      totalAfterTierDiscount: totalAfterTierV213,
      totalAmount: totalAfterTierAndRewardV240,
      currency: "MOP",
      cart,
      orderNote: String(body.orderNote || body.note || "").trim(),
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
    // V199: member cups/rewards are counted only after Telegram marks the order as picked_up.

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

    return json({ ok: true, orderNo, status: order.status, pickupTime, totalAmount: order.totalAmount, subtotalBeforeReward: order.subtotalBeforeReward, totalBeforeTierDiscount: order.totalBeforeTierDiscount, totalAfterTierDiscount: order.totalAfterTierDiscount, memberTierName: order.memberTierName, memberTierIcon: order.memberTierIcon, tierDiscount: order.tierDiscount, tierDiscountDetails: order.tierDiscountDetails, rewardUse: order.rewardUse, rewardDiscount: order.rewardDiscount, rewardFreeItems: order.rewardFreeItems, birthdayVoucherCount: order.birthdayVoucherCount, currency: order.currency });
  } catch (e) {
    return json({ ok: false, error: e.message || "提交失敗，請稍後再試" }, 500);
  }
}


async function ensureActiveMember(env, phone) {
  phone = normalizePhone(phone);
  if (!phone) throw new Error("會員資料不存在或已被刪除，請重新登入或重新註冊");

  // V214: merge all duplicate member records, prioritizing Telegram manual tier updates.
  const matches = [];
  const seen = new Set();

  function add(key, member) {
    if (!member || member.deletedAt || seen.has(key)) return;
    seen.add(key);
    const keyPhone = normalizePhone(String(key || "").replace(/^member:/, ""));
    const storedPhone = normalizePhone(member.phone || keyPhone);
    if (!samePhoneForMemberLookup(storedPhone, phone) && !samePhoneForMemberLookup(keyPhone, phone)) return;
    member.phone = storedPhone || keyPhone || phone;
    matches.push({ key, member });
  }

  for (const candidate of memberPhoneCandidates(phone)) {
    const key = "member:" + candidate;
    const raw = await env.ORDERS.get(key);
    if (!raw) continue;
    try { add(key, JSON.parse(raw)); } catch (_) {}
  }

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

  if (!matches.length) throw new Error("會員資料不存在或已被刪除，請重新登入或重新註冊");

  function manualKeyOf(member) {
    return String(member.manualTierKey || member.memberTierOverrideKey || member.memberTierManualKey || "").trim();
  }
  function timeOf(member) {
    return Math.max(
      new Date(member.manualTierUpdatedAt || 0).getTime() || 0,
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
    const m = manualSource.member;
    merged.manualTierKey = m.manualTierKey || m.memberTierOverrideKey || m.memberTierManualKey || "";
    merged.manualTierName = m.manualTierName || m.memberTierOverrideName || "";
    merged.manualTierIcon = m.manualTierIcon || m.memberTierOverrideIcon || "";
    merged.memberTierOverrideKey = merged.manualTierKey;
    merged.memberTierOverrideName = merged.manualTierName;
    merged.memberTierOverrideIcon = merged.manualTierIcon;
    merged.manualTierUpdatedAt = m.manualTierUpdatedAt || m.updatedAt || "";
    merged.manualTierUpdatedBy = m.manualTierUpdatedBy || "";
  }

  for (const item of matches) {
    const m = item.member || {};
    merged.totalOrders = Math.max(Number(merged.totalOrders || 0), Number(m.totalOrders || 0));
    merged.totalCups = Math.max(Number(merged.totalCups || 0), Number(m.totalCups || 0));
    merged.totalSpent = Math.max(Number(merged.totalSpent || 0), Number(m.totalSpent || 0));
    merged.rewardRedeemed = Math.max(Number(merged.rewardRedeemed || merged.rewardsRedeemed || 0), Number(m.rewardRedeemed || m.rewardsRedeemed || 0));
    merged.rewardsRedeemed = merged.rewardRedeemed;
    merged.giftVoucherBalance = Math.max(Number(merged.giftVoucherBalance || merged.giftVouchers || merged.manualGiftVouchers || 0), Number(m.giftVoucherBalance || m.giftVouchers || m.manualGiftVouchers || 0));
    merged.giftVouchers = merged.giftVoucherBalance;
    merged.manualGiftVouchers = merged.giftVoucherBalance;
  }

  merged.phone = normalizePhone(merged.phone || phone);
  // V237: preserve existing legacy aliases if they already exist, but do not create
  // new member:853xxxx aliases for fresh registrations/orders.
  const keysToSave = new Set(matches.map(x => x.key));
  keysToSave.add("member:" + normalizePhone(merged.phone || phone));
  keysToSave.add("member:" + phone);
  for (const key of keysToSave) {
    try { await env.ORDERS.put(key, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 3650 }); } catch (_) {}
  }

  return merged;
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

const V182_LIMITED_BEAN_SURCHARGE = 5;

function isLimitedBeanOrder(bean) {
  return String(bean || "").indexOf("Limited｜") === 0 || String(bean || "").indexOf("Limited|") === 0;
}

function limitedBeanSurchargeOrder(item) {
  if (!item) return 0;
  if (isLimitedBeanOrder(item.bean)) return V182_LIMITED_BEAN_SURCHARGE;
  return 0;
}

function calcBaseUnitPrice(item) {
  const key = priceKeyByName(item.name || item.title, item.cn || item.zh);
  const table = SKY31_PRICE_TABLE[key];
  if (!table) return Number(item.unitPrice || item.price || 0);
  if (table.fixed) return table.fixed;
  const temp = String(item.temp || item.temperature || "");
  const iced = temp.includes("Iced") || temp.includes("凍") || temp.includes("冻");
  return iced ? table.iced : table.hot;
}

function calcUnitPrice(item) {
  return calcBaseUnitPrice(item) + limitedBeanSurchargeOrder(item);
}



/* V213: final member tier discount calculation, based on backend member record. */


function birthdayVoucherMonthKeyV266(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  const ok = !Number.isNaN(d.getTime());
  const x = ok ? d : new Date();
  return x.getUTCFullYear() + "-" + String(x.getUTCMonth() + 1).padStart(2, "0");
}

function rewardNormalUseFromOrderV266(order) {
  if (!order) return 0;
  if (order.rewardNormalUse != null) return Math.max(0, Number(order.rewardNormalUse || 0));
  if (order.rewardBirthdayUse != null) return Math.max(0, Number(order.rewardUse || order.rewardUseRequested || 0) - Number(order.rewardBirthdayUse || 0));
  return Math.max(0, Number(order.rewardUse || order.rewardUseRequested || 0));
}

function rewardBirthdayUseFromOrderV266(order, monthKey) {
  if (!order) return 0;
  const use = Math.max(0, Number(order.rewardBirthdayUse || order.birthdayVoucherCount || 0));
  if (!use) return 0;
  const key = String(order.birthdayVoucherMonthKey || birthdayVoucherMonthKeyV266(order.createdAt || order.updatedAt || order.statusUpdatedAt || ""));
  return !monthKey || key === monthKey ? use : 0;
}

function birthdayVoucherUsedOrReservedV266(member) {
  member = member || {};
  return Math.max(0, Number(member.birthdayVoucherRedeemedThisMonth || 0)) +
         Math.max(0, Number(member.birthdayVoucherReservedThisMonth || 0));
}


function sky31BirthdayVoucherCountOrderV217(member) {
  member = member || {};
  const birthday = String(member.birthday || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return 0;

  const tier = sky31OrderDisplayTierV213(member);
  const key = String((tier && tier.key) || member.memberTierKey || member.manualTierKey || "").toLowerCase();
  const goldOrAbove = key === "gold" || key === "diamond" || key === "blackgold" || key === "vip";
  if (!goldOrAbove) return 0;

  if (birthdayVoucherUsedOrReservedV266(member) > 0) return 0;

  const month = Number(birthday.split("-")[1] || 0);
  const now = new Date();
  return month === now.getUTCMonth() + 1 ? 1 : 0;
}

function sky31OrderTierByKeyV213(key) {
  key = String(key || "").toLowerCase();
  if (key === "vip") key = "blackgold";
  const map = {
    regular: { key: "regular", name: "普通會員", icon: "🌱", cups: 0 },
    silver: { key: "silver", name: "銀卡會員", icon: "🥈", cups: 30 },
    gold: { key: "gold", name: "金卡會員", icon: "🥇", cups: 60 },
    diamond: { key: "diamond", name: "鑽石會員", icon: "💎", cups: 100 },
    blackgold: { key: "blackgold", name: "黑金會員", icon: "👑", cups: 180 }
  };
  return map[key] || null;
}

function sky31OrderTierByCupsV213(cups) {
  cups = Number(cups || 0);
  if (cups >= 180) return sky31OrderTierByKeyV213("blackgold");
  if (cups >= 100) return sky31OrderTierByKeyV213("diamond");
  if (cups >= 60) return sky31OrderTierByKeyV213("gold");
  if (cups >= 30) return sky31OrderTierByKeyV213("silver");
  return sky31OrderTierByKeyV213("regular");
}

function sky31OrderTierThresholdV216(key) {
  const tier = sky31OrderTierByKeyV213(key);
  return tier ? Number(tier.cups || 0) : 0;
}

function sky31OrderDisplayTierV213(member) {
  member = member || {};
  const totalCups = Number(member.totalCups || member.cups || member.totalItems || 0);
  const manualBase = sky31OrderTierByKeyV213(member.manualTierKey || member.memberTierOverrideKey || member.memberTierManualKey || "");

  if (!manualBase) {
    const natural = sky31OrderTierByKeyV213(member.memberTierKey || "") || sky31OrderTierByCupsV213(totalCups);
    return { ...(natural || sky31OrderTierByKeyV213("regular")), manual: false, effectiveCups: totalCups };
  }

  const baseCups = Number(member.manualTierBaseCups || sky31OrderTierThresholdV216(manualBase.key));
  const hasStart = member.manualTierStartCups != null || member.manualTierSetAtCups != null || member.manualTierOriginalCups != null;
  const startCups = hasStart ? Number(member.manualTierStartCups ?? member.manualTierSetAtCups ?? member.manualTierOriginalCups ?? 0) : null;
  const gained = hasStart ? Math.max(0, totalCups - Number(startCups || 0)) : 0;
  const effectiveCups = hasStart ? (baseCups + gained) : Math.max(totalCups, baseCups);
  const tier = sky31OrderTierByCupsV213(effectiveCups);

  return { ...tier, manual: true, manualBase, manualBaseCups: baseCups, manualStartCups: hasStart ? Number(startCups || 0) : totalCups, gainedSinceManualTier: hasStart ? gained : Math.max(0, totalCups - baseCups), effectiveCups };
}

function sky31OrderLimitedSurchargeTotalV213(cart) {
  return (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
    const qty = Math.max(1, Number(item.qty || item.quantity || 1));
    const surcharge = Number(item.beanSurcharge || item.limitedSurcharge || (isLimitedBeanOrder(item.bean) ? V182_LIMITED_BEAN_SURCHARGE : 0) || 0);
    return sum + surcharge * qty;
  }, 0);
}

function sky31OrderTierDiscountV213(member, cart, afterReward) {
  const tier = sky31OrderDisplayTierV213(member);
  const limitedTotal = sky31OrderLimitedSurchargeTotalV213(cart);
  const details = [];
  let discount = 0;

  if (tier.key === "silver") {
    const d = Math.min(limitedTotal, 5);
    if (d > 0) { discount += d; details.push("限定豆子加價豁免 ×1"); }
  } else if (tier.key === "gold") {
    const d = Math.min(limitedTotal, 10);
    if (d > 0) { discount += d; details.push("限定豆子加價豁免 ×2"); }
  } else if (tier.key === "diamond") {
    const d = limitedTotal;
    if (d > 0) { discount += d; details.push("限定豆子加價全數豁免"); }
  } else if (tier.key === "blackgold") {
    const d = Math.min(15, Math.max(0, Number(afterReward || 0)));
    if (d > 0) { discount += d; details.push("黑金會員 MOP 15 優惠"); }
  }

  discount = Math.min(Math.max(0, Number(afterReward || 0)), Math.round(discount * 100) / 100);
  return { tier, discount, details };
}


/* V240: apply stackable benefits without double-discounting the same surcharge.
   Calculation order: member tier bean-surcharge waiver first, then free-drink voucher on the discounted cup price. */
function sky31ExpandedOrderUnitsV240(cart) {
  const units = [];
  (Array.isArray(cart) ? cart : []).forEach((item, itemIndex) => {
    const qty = Math.max(1, Number(item.qty || item.quantity || 1));
    const unit = Number(calcUnitPrice(item) || item.unitPrice || item.price || 0);
    const surcharge = Math.max(0, Number(item.beanSurcharge || item.limitedSurcharge || (isLimitedBeanOrder(item.bean) ? V182_LIMITED_BEAN_SURCHARGE : 0) || 0));
    for (let i = 0; i < qty; i++) {
      units.push({
        itemIndex,
        cupIndex: i,
        title: item.title || item.name || item.cn || "飲品",
        unit,
        surcharge: Math.min(unit, surcharge),
        tierWaiver: 0,
        rewardUnit: unit
      });
    }
  });
  return units;
}

function sky31TierDiscountPlanV240(member, cart, subtotal) {
  const tier = sky31OrderDisplayTierV213(member);
  const units = sky31ExpandedOrderUnitsV240(cart);
  const details = [];
  let discount = 0;

  if (tier.key === "silver" || tier.key === "gold" || tier.key === "diamond") {
    const maxCount = tier.key === "silver" ? 1 : (tier.key === "gold" ? 2 : Infinity);
    let used = 0;
    for (const u of units) {
      if (used >= maxCount) break;
      if (u.surcharge <= 0) continue;
      u.tierWaiver = Math.min(u.surcharge, V182_LIMITED_BEAN_SURCHARGE);
      u.rewardUnit = Math.max(0, u.unit - u.tierWaiver);
      discount += u.tierWaiver;
      used += 1;
    }
    if (discount > 0) details.push(tier.key === "diamond" ? "限定豆子加價全數豁免" : "限定豆子加價豁免 ×" + used);
  } else if (tier.key === "blackgold") {
    const d = Math.min(15, Math.max(0, Number(subtotal || 0)));
    if (d > 0) {
      discount += d;
      details.push("黑金會員 MOP 15 優惠");
    }
  }

  discount = Math.min(Math.max(0, Number(subtotal || 0)), Math.round(discount * 100) / 100);
  return { tier, discount, details, units };
}

function sky31RewardDiscountForUnitsV240(units, availableRewards, capAmount) {
  const rewards = Math.max(0, Number(availableRewards || 0));
  const expanded = (Array.isArray(units) ? units : []).map(u => ({
    title: u.title || "飲品",
    unit: Math.max(0, Number(u.rewardUnit ?? u.unit ?? 0))
  })).sort((a, b) => b.unit - a.unit);
  const use = Math.min(rewards, expanded.length);
  const selected = expanded.slice(0, use);
  const rawDiscount = selected.reduce((sum, x) => sum + Number(x.unit || 0), 0);
  const discount = Math.min(Math.max(0, Number(capAmount || 0)), Math.round(rawDiscount * 100) / 100);
  return { useRewards: use, rewardDiscount: discount, freeItems: selected };
}

function sky31CalculateOrderDiscountsV240(member, cart, availableRewards) {
  const subtotal = Math.round(cartTotal(cart) * 100) / 100;
  const tierCalc = sky31TierDiscountPlanV240(member, cart, subtotal);
  const tierDiscount = Number(tierCalc.discount || 0);
  const totalAfterTier = Math.max(0, Math.round((subtotal - tierDiscount) * 100) / 100);
  const rewardCalc = sky31RewardDiscountForUnitsV240(tierCalc.units, availableRewards, totalAfterTier);
  const rewardDiscount = Number(rewardCalc.rewardDiscount || 0);
  const totalAmount = Math.max(0, Math.round((totalAfterTier - rewardDiscount) * 100) / 100);
  return {
    subtotal,
    tierCalc,
    tierDiscount,
    totalAfterTier,
    rewardUse: Number(rewardCalc.useRewards || 0),
    rewardDiscount,
    rewardFreeItems: rewardCalc.freeItems || [],
    totalAmount
  };
}

function money(n) {
  return "MOP " + String(Math.round(Number(n || 0) * 100) / 100);
}

function cartTotal(cart) {
  return (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
    const qty = Number(item.qty || item.quantity || 1);
    const unit = Number(calcUnitPrice(item) || item.unitPrice || item.price || 0);
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
    const surcharge = limitedBeanSurchargeOrder(base);
    const unit = calcUnitPrice(base);
    base.basePrice = unit - surcharge;
    base.beanSurcharge = surcharge;
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
      if (Number(item.beanSurcharge || 0) > 0) parts.push("限定豆子 +MOP " + Number(item.beanSurcharge || 0));
      lines.push("☕ " + title + " ×" + (item.qty || 1) + (parts.length ? " | " + parts.join(" | ") : "") + " | " + money(item.unitPrice || item.price || 0) + " × " + (item.qty || 1) + " = " + money(item.subtotal || 0));
      if (item.note && item.note !== "無備註") lines.push("備註：" + item.note);
      lines.push("");
    });
  }

  lines.push("────────────");
  if (Number(order.birthdayVoucherCount || 0) > 0) lines.push("生日月飲品券：" + Number(order.birthdayVoucherCount || 0) + " 張");
  if (Number(order.tierDiscount || 0) > 0) {
    const tierName = order.memberTierName || "會員等級";
    const detail = Array.isArray(order.tierDiscountDetails) && order.tierDiscountDetails.length ? "（" + order.tierDiscountDetails.join("、") + "）" : "";
    lines.push(tierName + "優惠" + detail + "：-" + money(order.tierDiscount));
  }
  if (Number(order.rewardDiscount || 0) > 0) lines.push("會員免單扣減：-" + money(order.rewardDiscount));
  lines.push("總額：" + money(order.totalAmount || cartTotal(order.cart)));
  if (order.orderNote) lines.push("整張訂單備註：" + order.orderNote);
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
  // V237: accept legacy records that were stored with a forced 853 prefix,
  // but never require new customer input to be rewritten to 853-prefixed form.
  if (phone.length > 3 && phone.startsWith("853")) return phone.slice(3);
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
  if (isLimitedBeanOrder(bean)) return "✨";
  if (bean.includes("淺烘") || bean.includes("浅烘")) return "🌸";
  if (bean.includes("中深烘") || bean.includes("拼配")) return "🍫";
  return "☕";
}

function cleanBeanName(bean) {
  const s = String(bean || "");
  if (isLimitedBeanOrder(s)) {
    const parts = s.includes("｜") ? s.split("｜") : s.split("|");
    const name = parts[1] || "期間限定豆子";
    return name + "（限定豆子 +MOP 5）";
  }
  return s.split("|")[0].split("｜")[0].trim();
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
  // V237: save new order indexes exactly as the customer/member phone is stored.
  // Legacy 853-prefixed lookups are still supported by status/member queries, but
  // this function no longer creates fresh 853 aliases.
  const phones = [order.phone, order.memberPhone, order.submittedPhone];

  const uniquePhones = Array.from(new Set(phones.map(normalizePhone).filter(Boolean)));

  for (const phone of uniquePhones) {
    await env.ORDERS.put("phone:" + phone + ":" + order.orderNo, order.orderNo, { expirationTtl: ttl });
    await env.ORDERS.put("member_ordered:" + phone + ":" + order.orderNo, order.orderNo, { expirationTtl: ttl || 60 * 60 * 24 * 3650 });
  }
}

async function updateMemberAfterOrder(env, order, ttl) {
  // V199: count only picked_up successful transactions.
  if (String(order && order.status || '').toLowerCase() !== 'picked_up') return;
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


/* V192: rewards redemption helpers */
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
  const gifted = Math.max(0, Number(member.giftVoucherBalance || member.giftVouchers || member.manualGiftVouchers || 0));
  const earned = Math.floor(totalCups / 10);
  const available = Math.max(0, earned + gifted - redeemed - reserved);
  return {
    totalCups,
    earnedRewards: earned,
    giftedRewards: gifted,
    giftVoucherBalance: gifted,
    redeemedRewards: redeemed,
    reservedRewards: reserved,
    availableRewards: available,
    tier: sky31RewardTierV192(totalCups)
  };
}

function sky31OrderDrinkCupCountV192(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => {
    return sum + Math.max(0, Number(item.qty || 1));
  }, 0);
}

function sky31RewardDiscountForItemsV192(items, availableRewards) {
  const rewards = Math.max(0, Number(availableRewards || 0));
  const expanded = [];
  (Array.isArray(items) ? items : []).forEach(item => {
    const qty = Math.max(0, Number(item.qty || 1));
    const unit = Number(item.unitPrice || item.price || 0);
    for (let i = 0; i < qty; i++) expanded.push({ title: item.title || item.name || "飲品", unit });
  });
  expanded.sort((a, b) => b.unit - a.unit);
  const use = Math.min(rewards, expanded.length);
  const selected = expanded.slice(0, use);
  const discount = selected.reduce((sum, x) => sum + Number(x.unit || 0), 0);
  return {
    useRewards: use,
    rewardDiscount: discount,
    freeItems: selected
  };
}

async function sky31LoadMemberForRewardV192(env, phone) {
  const p = String(phone || "").replace(/\D/g, "");
  if (!p || !env || !env.ORDERS) return null;
  try {
    const raw = await env.ORDERS.get("member:" + p);
    const member = raw ? JSON.parse(raw) : null;
    return await sky31RecomputeMemberForRewardV199(env, member || { phone: p }, p);
  } catch (_) {
    return null;
  }
}

async function sky31SaveMemberAfterRewardV192(env, member, phone, cupAdd, redeemUse) {
  if (!member || !env || !env.ORDERS) return null;
  const p = String(phone || member.phone || "").replace(/\D/g, "");
  if (!p) return null;
  member.totalCups = Number(member.totalCups || member.cups || member.totalItems || 0) + Number(cupAdd || 0);
  member.rewardRedeemed = Number(member.rewardRedeemed || member.rewardsRedeemed || 0) + Number(redeemUse || 0);
  member.updatedAt = new Date().toISOString();
  member.rewards = sky31RewardsFromMemberV192(member);
  member.memberTier = member.rewards.tier.name;
  member.memberTierIcon = member.rewards.tier.icon;
  member.memberTierKey = member.rewards.tier.key;
  try { await env.ORDERS.put("member:" + p, JSON.stringify(member)); } catch (_) {}
  return member;
}


function sky31RewardTelegramLineV192(order) {
  const use = Number(order && order.rewardUse || 0);
  const discount = Number(order && order.rewardDiscount || 0);
  if (!use || !discount) return "";
  return "🎁 會員獎賞兌換 ×" + use + "｜-" + money(discount);
}


/* V199: reward availability is based on picked_up successful transactions only. */
function sky31OrderSuccessV199(order) {
  // V239: reward availability on website must match Telegram backend exactly.
  // Only orders marked as picked_up / 已領取 count toward cups and free vouchers.
  if (!order) return false;
  const s = String(order.status || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "cancelled" || s === "canceled" || s.indexOf("cancel") >= 0) return false;
  return s === "picked_up" || s === "pickedup";
}

function sky31SamePhoneV199(a, b) {
  a = normalizePhone(a);
  b = normalizePhone(b);
  if (!a || !b) return false;
  if (a === b) return true;
  return phoneWithoutMacauCode(a) === phoneWithoutMacauCode(b);
}

async function sky31RecomputeMemberForRewardV199(env, member, phone) {
  phone = normalizePhone(phone || (member && member.phone));
  if (!phone || !env || !env.ORDERS) return member;

  const orderNos = new Set();
  const candidates = memberPhoneCandidates(phone);
  for (const candidate of candidates) {
    let cursor = undefined;
    do {
      const page = await env.ORDERS.list({ prefix: "phone:" + candidate + ":", cursor });
      for (const key of (page.keys || [])) {
        const no = String(key.name || "").replace("phone:" + candidate + ":", "");
        if (no) orderNos.add(no);
      }
      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor);
  }

  let totalOrders = 0;
  let totalCups = 0;
  let totalSpent = 0;
  let rewardRedeemed = 0;
  let rewardReserved = 0;
  let birthdayVoucherRedeemedThisMonth = 0;
  let birthdayVoucherReservedThisMonth = 0;
  const currentMonthKey = birthdayVoucherMonthKeyV266(new Date());

  for (const no of orderNos) {
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;
    let order = null;
    try { order = JSON.parse(raw); } catch (_) { continue; }
    const phones = [order.phone, order.memberPhone, order.submittedPhone].map(normalizePhone).filter(Boolean);
    if (!phones.some(p => sky31SamePhoneV199(p, phone))) continue;

    const success = sky31OrderSuccessV199(order);
    const cancelled = isCancelledOrder(order);
    const normalUse = rewardNormalUseFromOrderV266(order);
    const birthdayUse = rewardBirthdayUseFromOrderV266(order, currentMonthKey);

    if (success) {
      totalOrders += 1;
      totalCups += sky31OrderDrinkCupCountV192(order.cart);
      totalSpent += Number(order.totalAmount || 0);
      rewardRedeemed += normalUse;
      birthdayVoucherRedeemedThisMonth += birthdayUse;
    } else if (!cancelled) {
      rewardReserved += normalUse;
      birthdayVoucherReservedThisMonth += birthdayUse;
    }
  }

  const scannedTotalSpent = Math.round(totalSpent * 100) / 100;
  return {
    ...(member || {}),
    phone,
    // V239: exact recompute, not Math.max(old, scanned), so undo/cancel deducts properly.
    totalOrders,
    totalCups,
    totalSpent: scannedTotalSpent,
    rewardRedeemed,
    rewardsRedeemed: rewardRedeemed,
    rewardReserved,
    rewardsReserved: rewardReserved,
    birthdayVoucherRedeemedThisMonth,
    birthdayVoucherReservedThisMonth
  };
}
