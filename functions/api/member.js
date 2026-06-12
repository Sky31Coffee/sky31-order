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

    const now = new Date().toISOString();
    const existing = await loadMember(env, phone);

    const member = {
      ...(existing || {}),
      phone,
      name,
      birthday,
      note,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      totalOrders: Number(existing?.totalOrders || 0),
      totalCups: Number(existing?.totalCups || 0),
      totalSpent: Number(existing?.totalSpent || 0),
      recentOrderNos: Array.isArray(existing?.recentOrderNos) ? existing.recentOrderNos : []
    };

    await env.ORDERS.put("member:" + phone, JSON.stringify(member));

    const withStats = await enrichMemberWithOrders(env, member);
    return json({ ok: true, member: withStats });
  } catch (e) {
    return json({ ok: false, error: e.message || "保存會員失敗" }, 500);
  }
}

async function loadMember(env, phone) {
  const raw = await env.ORDERS.get("member:" + phone);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
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

  for (const no of orderNos) {
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;

    let order = null;
    try { order = JSON.parse(raw); } catch (_) { continue; }
    if (!order || normalizePhone(order.phone) !== phone) continue;

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
        currency: order.currency || "MOP"
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
    lastOrderAt: member.lastOrderAt || "",
    lastOrderNo: member.lastOrderNo || "",
    totalOrders,
    totalCups,
    totalSpent: Math.round(totalSpent * 100) / 100,
    recentOrders: orders
  };
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
