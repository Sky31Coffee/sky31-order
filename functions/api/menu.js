
const MENU_KEY = "sky31:limited_menu:v1";

const DEFAULT_LIMITED_MENU = {
  updatedAt: "",
  updatedBy: "default",
  cleared: false,
  limitedItems: [
    {
      id: "soe-geisha",
      active: true,
      name: "Limited SOE Americano",
      cn: "期間限定 SOE 美式",
      desc: "使用當季精品 SOE 豆製作，果香明亮，層次乾淨。",
      bean: "Seasonal Specialty SOE Geisha",
      flavor: "櫻桃・草莓・紅石榴・紅酒",
      note: "適合喜歡果香、乾淨酸甜感的客人。",
      milk: false,
      tempMode: "both",
      hotPrice: 38,
      icedPrice: 42,
      image: "./americano-new.jpg"
    }
  ]
};

export async function onRequest(context) {
  const method = context.request.method;
  if (method !== "GET" && method !== "HEAD") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const config = await getLimitedMenuConfig(context.env);
    return json({
      ok: true,
      version: "V175",
      limitedItems: sanitizePublicItems(config.limitedItems || []),
      updatedAt: config.updatedAt || "",
      updatedBy: config.updatedBy || ""
    });
  } catch (e) {
    return json({ ok: false, error: e.message || "menu load failed" }, 500);
  }
}

async function getLimitedMenuConfig(env) {
  const raw = await env.ORDERS.get(MENU_KEY);
  if (!raw) return DEFAULT_LIMITED_MENU;
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object") return DEFAULT_LIMITED_MENU;
    if (config.cleared === true) return { ...config, limitedItems: [] };
    if (!Array.isArray(config.limitedItems)) config.limitedItems = [];
    return config;
  } catch (_) {
    return DEFAULT_LIMITED_MENU;
  }
}

function sanitizePublicItems(items) {
  return (Array.isArray(items) ? items : []).map(item => ({
    id: safeId(item.id),
    active: item.active !== false,
    name: String(item.name || item.title || "Limited Coffee").trim(),
    cn: String(item.cn || item.zh || item.chinese || "期間限定").trim(),
    desc: String(item.desc || item.description || "").trim(),
    bean: String(item.bean || item.beanName || "期間限定豆子").trim(),
    flavor: String(item.flavor || item.tasting || "").trim(),
    note: String(item.note || item.beanNote || "").trim(),
    milk: item.milk !== false,
    tempMode: String(item.tempMode || item.temp || "both").trim() || "both",
    fixedPrice: Number(item.fixedPrice || item.price || 0) || 0,
    hotPrice: Number(item.hotPrice || item.hot || 0) || 0,
    icedPrice: Number(item.icedPrice || item.iced || 0) || 0,
    image: String(item.image || item.imageUrl || "").trim() || "./americano-new.jpg",
    updatedAt: item.updatedAt || ""
  })).filter(item => item.id && item.name && item.cn);
}

function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
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
