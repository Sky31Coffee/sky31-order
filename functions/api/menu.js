
const MENU_KEY = "sky31:limited_menu:v1";

const DEFAULT_LIMITED_MENU = {
  updatedAt: "",
  updatedBy: "default-empty",
  cleared: true,
  limitedItems: []
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
      version: "V182",
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
    type: "bean",
    active: item.active !== false,
    name: String(item.name || item.bean || item.title || "期間限定豆子").trim(),
    cn: String(item.cn || item.zh || item.chinese || item.name || item.bean || "期間限定豆子").trim(),
    desc: String(item.desc || item.description || "").trim(),
    bean: String(item.bean || item.beanName || item.name || "期間限定豆子").trim(),
    flavor: String(item.flavor || item.tasting || "").trim(),
    note: String(item.note || item.beanNote || "").trim(),
    surcharge: Number(item.surcharge || item.limitedSurcharge || 5) || 5,
    limitedSurcharge: Number(item.surcharge || item.limitedSurcharge || 5) || 5,
    updatedAt: item.updatedAt || ""
  })).filter(item => item.id && item.name && item.bean);
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
