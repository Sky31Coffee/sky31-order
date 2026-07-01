
const MENU_KEY = "sky31:limited_menu:v1";
const MAINTENANCE_KEY_V218 = "sky31:maintenance:v1";

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
    const visible = publicLimitedItemsV187(config);
    const maintenanceV218 = await getMaintenanceConfigV218(context.env);
    return json({
      ok: true,
      version: "V223",
      limitedItems: visible,
      currentLimitedBeanId: visible[0] ? visible[0].id : "",
      currentLimitedBeanIds: visible.map(item => item.id),
      allLimitedItems: publicAllLimitedItemsV187(config),
      updatedAt: config.updatedAt || "",
      updatedBy: config.updatedBy || "",
      maintenance: maintenanceV218
    });
  } catch (e) {
    return json({ ok: false, error: e.message || "menu load failed" }, 500);
  }
}


async function getMaintenanceConfigV218(env) {
  try {
    const raw = await env.ORDERS.get(MAINTENANCE_KEY_V218);
    if (!raw) return { active: false, message: "", updatedAt: "", updatedBy: "" };
    const config = JSON.parse(raw);
    return {
      active: config && config.active === true,
      message: String((config && config.message) || ""),
      updatedAt: String((config && config.updatedAt) || ""),
      updatedBy: String((config && config.updatedBy) || "")
    };
  } catch (_) {
    return { active: false, message: "", updatedAt: "", updatedBy: "" };
  }
}

function publicLimitedItemsV187(config) {
  const all = sanitizePublicItems(config && config.limitedItems ? config.limitedItems : []);
  const active = all.filter(item => item.active !== false && item.deleted !== true);
  if (!active.length) return [];

  let ids = [];
  if (Array.isArray(config.currentLimitedBeanIds)) {
    ids = config.currentLimitedBeanIds.map(safeId).filter(Boolean);
  } else if (config.currentLimitedBeanId) {
    ids = [safeId(config.currentLimitedBeanId)];
  }

  const selected = [];
  ids.forEach(id => {
    const item = active.find(x => safeId(x.id) === id);
    if (item && !selected.find(x => safeId(x.id) === safeId(item.id))) selected.push(item);
  });

  active.forEach(item => {
    if (selected.length < 2 && !selected.find(x => safeId(x.id) === safeId(item.id))) selected.push(item);
  });

  return selected.slice(0, 2);
}

function publicAllLimitedItemsV187(config) {
  return sanitizePublicItems(config && config.limitedItems ? config.limitedItems : []);
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
  function cleanText(v) {
    return String(v == null ? "" : v).trim();
  }
  return (Array.isArray(items) ? items : []).map(item => {
    const beanName = cleanText(item.beanName || item.name || item.title || item.label || item.cn || item.zh || item.chinese || item.bean);
    const bean = cleanText(item.beanName || item.name || item.title || item.label || item.cn || item.bean || "期間限定豆子");
    const name = cleanText(item.name || item.beanName || item.title || item.label || item.bean || "期間限定豆子");
    const desc = cleanText(item.desc || item.description || item.note || item.beanNote || item.subtitle || item.origin || item.region);
    const flavor = cleanText(item.flavor || item.beanFlavor || item.tasting || item.taste || item.notes);
    const note = cleanText(item.note || item.beanNote || item.desc || item.description || item.subtitle);
    return {
      id: safeId(item.id),
      type: "bean",
      active: item.active !== false,
      deleted: item.deleted === true,
      name,
      bean,
      beanName,
      title: cleanText(item.title || ""),
      label: cleanText(item.label || ""),
      cn: cleanText(item.cn || item.zh || item.chinese || ""),
      zh: cleanText(item.zh || item.chinese || ""),
      desc,
      description: cleanText(item.description || item.desc || ""),
      subtitle: cleanText(item.subtitle || ""),
      origin: cleanText(item.origin || ""),
      region: cleanText(item.region || ""),
      flavor,
      beanFlavor: cleanText(item.beanFlavor || item.flavor || ""),
      tasting: cleanText(item.tasting || item.flavor || ""),
      note,
      beanNote: cleanText(item.beanNote || item.note || ""),
      surcharge: Number(item.surcharge || item.limitedSurcharge || 5) || 5,
      limitedSurcharge: Number(item.surcharge || item.limitedSurcharge || 5) || 5,
      updatedAt: item.updatedAt || ""
    };
  }).filter(item => item.id && (item.bean || item.name || item.beanName));
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
