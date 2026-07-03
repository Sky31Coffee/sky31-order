
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const orderNo = (url.searchParams.get("orderNo") || "").trim().replace(/^#/, "").toUpperCase();
  const phone = normalizePhone(url.searchParams.get("phone") || "");

  if (!phone) {
    return json({ ok: false, error: "請輸入手機號碼" }, 400);
  }

  if (orderNo) {
    const raw = await env.ORDERS.get("order:" + orderNo);
    if (!raw) return json({ ok: false, error: "查詢不到此訂單號" }, 404);

    const order = JSON.parse(raw);
    if (![order.phone, order.memberPhone, order.submittedPhone].some(p => samePhone(p, phone))) {
      return json({ ok: false, error: "手機號碼不正確" }, 403);
    }

    return json(formatOrder(order));
  }

  const orderNos = await collectOrderNosForPhone(env, phone);
  const orders = [];

  for (const no of orderNos) {
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;

    let order = null;
    try { order = JSON.parse(raw); } catch (_) { continue; }

    const orderPhones = [
      normalizePhone(order.phone),
      normalizePhone(order.memberPhone),
      normalizePhone(order.submittedPhone)
    ].filter(Boolean);

    if (!orderPhones.some(p => samePhone(p, phone))) continue;

    orders.push(formatOrder(order));
  }

  const sorted = sortFormattedOrders(orders).slice(0, 30);

  if (!sorted.length) {
    return json({ ok: false, error: "查詢不到目前可顯示的訂單" }, 404);
  }

  return json({ ok: true, orders: sorted });
}


async function collectOrderNosForPhone(env, phone) {
  const found = new Set();
  function add(no) {
    no = String(no || "").trim();
    if (no) found.add(no);
  }

  for (const candidate of phoneCandidates(phone)) {
    const p1 = "phone:" + candidate + ":";
    await listKeys(env, p1, 5000, key => add(key.name.replace(p1, "")));

    const p2 = "member_ordered:" + candidate + ":";
    await listKeys(env, p2, 5000, key => add(key.name.replace(p2, "")));
  }

  // Fallback for old records without phone index.
  await listKeys(env, "order:", 5000, async key => {
    const raw = await env.ORDERS.get(key.name);
    if (!raw) return;

    try {
      const order = JSON.parse(raw);
      const phones = [
        normalizePhone(order.phone),
        normalizePhone(order.memberPhone),
        normalizePhone(order.submittedPhone)
      ].filter(Boolean);

      if (phones.some(p => samePhone(p, phone))) {
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

function phoneCandidates(phone) {
  phone = normalizePhone(phone);
  return phone ? [phone] : [];
}

function phoneWithoutMacauCode(phone) {
  return normalizePhone(phone || "");
}

function samePhone(a, b) {
  a = normalizePhone(a);
  b = normalizePhone(b);
  return !!a && !!b && a === b;
}

function latestFormattedOrderTime(order) {
  return Math.max(
    new Date(order.statusUpdatedAt || 0).getTime() || 0,
    new Date(order.updatedAt || 0).getTime() || 0,
    new Date(order.cancelledAt || 0).getTime() || 0,
    new Date(order.pickedUpAt || 0).getTime() || 0,
    new Date(order.completedAt || 0).getTime() || 0,
    new Date(order.createdAt || 0).getTime() || 0
  );
}

function isFormattedCancelled(order) {
  const s = String(order.status || "").toLowerCase();
  return s === "cancelled" || s === "canceled" || s.indexOf("cancel") >= 0;
}

function sortFormattedOrders(orders) {
  return (Array.isArray(orders) ? orders : []).slice().sort((a, b) => {
    const ac = isFormattedCancelled(a) ? 1 : 0;
    const bc = isFormattedCancelled(b) ? 1 : 0;
    if (ac !== bc) return ac - bc;

    const at = latestFormattedOrderTime(a);
    const bt = latestFormattedOrderTime(b);
    if (bt !== at) return bt - at;

    return String(b.orderNo || "").localeCompare(String(a.orderNo || ""));
  });
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


function sky31PaidAmountV284(order, fallbackCart) {
  if (order && order.totalAmount !== undefined && order.totalAmount !== null) {
    const n = Number(order.totalAmount);
    return Number.isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : 0;
  }
  return Math.max(0, Math.round(Number(cartTotal(fallbackCart || (order && order.cart) || []) || 0) * 100) / 100);
}

function cartCupsV278(cart) {
  return (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
    const qty = Number(item.qty || item.quantity || 1);
    return sum + (Number.isFinite(qty) && qty > 0 ? qty : 1);
  }, 0);
}

function voucherCupsV278(order) {
  if (!order) return 0;
  const rewardUse = Math.max(0, Number(order.rewardUse || order.rewardUseRequested || 0));
  const birthdayUse = Math.max(0, Number(order.rewardBirthdayUse || order.birthdayVoucherCount || 0));
  const normalUse = Math.max(0, Number(order.rewardNormalUse || 0));
  const giftUse = Math.max(0, Number(order.rewardGiftUse || 0));
  const earnedUse = Math.max(0, Number(order.rewardEarnedUse || 0));
  return Math.max(rewardUse, normalUse + birthdayUse, giftUse + earnedUse + birthdayUse);
}

function loyaltyCupsV278(order) {
  return Math.max(0, cartCupsV278(order && order.cart) - voucherCupsV278(order));
}


function formatOrder(order) {
  const cart = Array.isArray(order.cart) ? order.cart : [];
  const orderCups = cartCupsV278(cart);
  const redeemedFreeCups = voucherCupsV278(order);
  const loyaltyCups = loyaltyCupsV278(order);

  return {
    ok: true,
    orderNo: order.orderNo,
    status: order.status || "pending",
    displayStatus: order.status || "pending",
    pickupTime: order.pickupTime || order.pickup || "",
    totalAmount: sky31PaidAmountV284(order, cart),
    totalCups: orderCups,
    orderCups,
    totalOrderCups: orderCups,
    loyaltyCups,
    paidCups: loyaltyCups,
    accumulatedCups: loyaltyCups,
    redeemedFreeCups,
    freeRedeemedCups: redeemedFreeCups,
    voucherCups: redeemedFreeCups,
    currency: order.currency || "MOP",
    createdAt: order.createdAt || "",
    updatedAt: order.updatedAt || order.statusUpdatedAt || order.createdAt || "",
    statusUpdatedAt: order.statusUpdatedAt || order.updatedAt || "",
    confirmedAt: order.confirmedAt || null,
    makingAt: order.makingAt || null,
    completedAt: order.completedAt || null,
    pickedUpAt: order.pickedUpAt || null,
    cancelledAt: order.cancelledAt || null,
    restoredAt: order.restoredAt || null,
    statusBeforeCancel: order.statusBeforeCancel || null,
    customerName: order.customerName || "",
    phone: order.phone || "",
    pickup: order.pickup || "",
    orderText: order.orderText || "",
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
    cart: cart.map(item => {
      const base = {
        name: item.name || item.title || "",
        cn: item.cn || item.zh || "",
        qty: Number(item.qty || item.quantity || 1),
        image: item.image || "",
        bean: item.bean || "",
        beanDisplay: limitedBeanDisplayV204(item.bean || ""),
        flavor: item.flavor || "",
        temp: item.temp || item.temperature || "",
        ice: item.ice || "",
        milk: item.milk || "",
        pickup: item.pickup || "",
        note: item.note || ""
      };
      const unit = Number(item.unitPrice || item.price || calcUnitPrice(base) || 0);
      base.unitPrice = unit;
      base.price = unit;
      base.subtotal = Number(item.subtotal || unit * base.qty || 0);
      base.currency = item.currency || order.currency || "MOP";
      return base;
    })
  };
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
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


/* V204: limited bean display helper for future status clients. */
function limitedBeanDisplayV204(bean) {
  const s = String(bean || "").trim();
  if (!s) return "";
  if (s.indexOf("Limited｜") === 0 || s.indexOf("Limited|") === 0) {
    const parts = s.indexOf("｜") >= 0 ? s.split("｜") : s.split("|");
    const name = String(parts[1] || "期間限定豆子").trim();
    const flavor = parts.slice(2).join("｜").replace(/^風味[:：]?\s*/,"").trim();
    return name + (flavor ? "（限定豆子｜" + flavor + "）" : "（限定豆子）");
  }
  return s.split("|")[0].split("｜")[0].trim();
}
