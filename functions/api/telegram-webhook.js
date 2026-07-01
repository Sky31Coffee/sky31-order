export async function onRequest(context) {
  const method = (context.request && context.request.method) || "GET";

  // V172: universal handler prevents Cloudflare Pages returning
  // "405 Method Not Allowed" for Telegram POST webhook callbacks.
  if (method === "GET" || method === "HEAD") {
    return json({
      ok: true,
      endpoint: "telegram-webhook",
      version: "V175",
      method,
      message: "Webhook endpoint reachable. Telegram sends POST updates here."
    });
  }

  if (method === "POST") {
    return handleTelegramPost(context);
  }

  return json({ ok: false, error: "Method not allowed", method }, 405);
}

async function handleTelegramPost(context) {
  const { request, env } = context;
  const update = await request.json();

  if (!update.callback_query) {
    const message = update.message || update.edited_message;
    if (message && message.text) {
      return handleTelegramTextCommand(env, message);
    }
    return json({ ok: true });
  }

  const cq = update.callback_query;
  const data = cq.data || "";

  // V171: immediately and synchronously acknowledge Telegram callback.
  // If this is not awaited, the runtime may return before the request finishes,
  // causing Telegram to keep showing Loading...
  await answerCallback(env, cq.id, "處理中…");

  if (data.startsWith("limited_")) {
    return handleLimitedMenuAction(env, cq, data);
  }

  if (
    data.startsWith("member_list:") ||
    data.startsWith("member_view_active:") ||
    data.startsWith("member_view_deleted:")
  ) {
    return handleMemberQueryAction(env, cq, data);
  }

  if (
    data.startsWith("member_delete:") ||
    data.startsWith("member_restore:") ||
    data.startsWith("member_cancel_delete:") ||
    data.startsWith("member_delete_confirmed:")
  ) {
    return handleMemberAction(env, cq, data);
  }
  const [action, orderNo] = data.split(":");
  if (!orderNo) return stop(env, cq, "操作資料無效");

  const order = await getOrder(env, orderNo, cq);
  if (!order) return json({ ok: true });

  const now = new Date().toISOString();

  if (action === "confirm") {
    if (order.status === "cancelled") return stop(env, cq, "此訂單已取消，請先恢復訂單");
    order.status = "confirmed";
    order.confirmedAt = now;
    order.makingAt = null;
    order.completedAt = null;
    order.pickedUpAt = null;
    clearCancelBackup(order);
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已確認訂單 #" + order.orderNo);
  }

  if (action === "undo_confirm") {
    if (order.status !== "confirmed") return stop(env, cq, "目前不是已確認狀態");
    order.status = "pending";
    order.confirmedAt = null;
    order.makingAt = null;
    order.completedAt = null;
    order.pickedUpAt = null;
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已撤回確認 #" + order.orderNo);
  }

  if (action === "make") {
    if (order.status === "cancelled") return stop(env, cq, "此訂單已取消，請先恢復訂單");
    if (order.status === "pending" || !order.status) return stop(env, cq, "請先確認訂單");
    order.status = "making";
    if (!order.confirmedAt) order.confirmedAt = now;
    order.makingAt = now;
    order.completedAt = null;
    order.pickedUpAt = null;
    clearCancelBackup(order);
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已開始製作 #" + order.orderNo);
  }

  if (action === "undo_make") {
    if (order.status !== "making") return stop(env, cq, "目前不是製作中狀態");
    order.status = "confirmed";
    order.makingAt = null;
    order.completedAt = null;
    order.pickedUpAt = null;
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已撤回製作 #" + order.orderNo);
  }

  if (action === "complete") {
    if (order.status === "cancelled") return stop(env, cq, "此訂單已取消，請先恢復訂單");
    if (order.status === "pending" || !order.status) return stop(env, cq, "請先確認訂單");
    if (order.status === "confirmed") return stop(env, cq, "請先開始製作");
    order.status = "completed";
    if (!order.confirmedAt) order.confirmedAt = now;
    if (!order.makingAt) order.makingAt = now;
    order.completedAt = now;
    order.pickedUpAt = null;
    clearCancelBackup(order);
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已完成 #" + order.orderNo);
  }

  if (action === "undo_complete") {
    if (order.status === "picked_up") return stop(env, cq, "請先撤回領取，再撤回完成");
    if (order.status !== "completed") return stop(env, cq, "目前不是已完成狀態");
    order.status = "making";
    order.completedAt = null;
    order.pickedUpAt = null;
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已撤回完成 #" + order.orderNo);
  }

  if (action === "pickup") {
    if (order.status !== "completed") return stop(env, cq, "請先完成訂單");
    order.status = "picked_up";
    if (!order.confirmedAt) order.confirmedAt = now;
    if (!order.makingAt) order.makingAt = now;
    if (!order.completedAt) order.completedAt = now;
    order.pickedUpAt = now;
    clearCancelBackup(order);
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已領取 #" + order.orderNo);
  }

  if (action === "undo_pickup") {
    if (order.status !== "picked_up") return stop(env, cq, "目前不是已領取狀態");
    order.status = "completed";
    order.pickedUpAt = null;
    if (!order.completedAt) order.completedAt = now;
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已撤回領取 #" + order.orderNo);
  }

  if (action === "cancel") {
    if (order.status === "cancelled") return stop(env, cq, "此訂單已經取消");
    order.statusBeforeCancel = normalizeStatus(order.status || "pending");
    order.confirmedAtBeforeCancel = order.confirmedAt || null;
    order.makingAtBeforeCancel = order.makingAt || null;
    order.completedAtBeforeCancel = order.completedAt || null;
    order.pickedUpAtBeforeCancel = order.pickedUpAt || null;
    order.status = "cancelled";
    order.cancelledAt = now;
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已取消 #" + order.orderNo);
  }

  if (action === "restore") {
    if (order.status !== "cancelled") return stop(env, cq, "目前不是已取消狀態");
    const s = normalizeStatus(order.statusBeforeCancel || "pending");
    order.status = s;
    order.cancelledAt = null;
    order.restoredAt = now;

    order.confirmedAt = order.confirmedAtBeforeCancel || null;
    order.makingAt = order.makingAtBeforeCancel || null;
    order.completedAt = order.completedAtBeforeCancel || null;
    order.pickedUpAt = order.pickedUpAtBeforeCancel || null;

    if (s === "confirmed" && !order.confirmedAt) order.confirmedAt = now;
    if (s === "making") {
      if (!order.confirmedAt) order.confirmedAt = now;
      if (!order.makingAt) order.makingAt = now;
    }
    if (s === "completed") {
      if (!order.confirmedAt) order.confirmedAt = now;
      if (!order.makingAt) order.makingAt = now;
      if (!order.completedAt) order.completedAt = now;
    }
    if (s === "picked_up") {
      if (!order.confirmedAt) order.confirmedAt = now;
      if (!order.makingAt) order.makingAt = now;
      if (!order.completedAt) order.completedAt = now;
      if (!order.pickedUpAt) order.pickedUpAt = now;
    }

    clearCancelBackup(order);
    await saveAndRefresh(env, cq, order);
    return stop(env, cq, "已恢復 #" + order.orderNo);
  }

  return json({ ok: true });
}


async function handleTelegramTextCommand(env, message) {
  const text = String(message.text || "").trim();
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;

  if (isLimitedMenuCommand(text)) {
    return handleLimitedMenuTextCommand(env, message, text);
  }

  if (!isMemberQueryCommand(text)) {
    return json({ ok: true });
  }

  const members = await listTelegramMembers(env);
  await sendTelegramMessage(
    env,
    chatId,
    buildMemberListText(members),
    buildMemberListMarkup(members)
  );

  return json({ ok: true });
}

function isMemberQueryCommand(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "查詢用戶" ||
    t === "查询用户" ||
    t === "查詢會員" ||
    t === "查询会员" ||
    t === "會員查詢" ||
    t === "会员查询" ||
    t === "/members" ||
    t === "/member" ||
    t === "members"
  );
}


const LIMITED_MENU_KEY = "sky31:limited_menu:v1";

function isLimitedMenuCommand(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "/limited" ||
    t === "/limited_help" ||
    t === "限定" ||
    t === "限定列表" ||
    t === "期間限定" ||
    t === "期间限定" ||
    t === "限定說明" ||
    t === "限定说明" ||
    t.startsWith("新增限定") ||
    t.startsWith("添加限定") ||
    t.startsWith("編輯限定") ||
    t.startsWith("编辑限定") ||
    t.startsWith("刪除限定") ||
    t.startsWith("删除限定") ||
    t.startsWith("停用限定") ||
    t.startsWith("啟用限定") ||
    t.startsWith("启用限定") ||
    t.startsWith("清空限定")
  );
}

async function handleLimitedMenuTextCommand(env, message, text) {
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;

  if (!isAuthorizedTelegramChat(env, chatId)) {
    await sendTelegramMessage(env, chatId, "沒有權限修改 Sky31 期間限定菜單。", null);
    return json({ ok: true });
  }

  const t = String(text || "").trim();
  const lower = t.toLowerCase();

  if (lower === "/limited_help" || t === "限定說明" || t === "限定说明") {
    await sendTelegramMessage(env, chatId, buildLimitedHelpText(), null);
    return json({ ok: true });
  }

  if (lower === "/limited" || t === "限定" || t === "限定列表" || t === "期間限定" || t === "期间限定") {
    const config = await getLimitedMenuConfig(env);
    await sendTelegramMessage(env, chatId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("清空限定")) {
    const config = await saveLimitedMenuConfig(env, { limitedItems: [], cleared: true, updatedAt: new Date().toISOString(), updatedBy: "telegram" });
    await sendTelegramMessage(env, chatId, "已清空所有期間限定項目。\n網站會即時隱藏 Limited 區域。", buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("刪除限定") || t.startsWith("删除限定")) {
    const id = cleanLimitedId(t.replace(/^刪除限定|^删除限定/, "").trim());
    const config = await getLimitedMenuConfig(env);
    const before = config.limitedItems.length;
    config.limitedItems = config.limitedItems.filter(item => cleanLimitedId(item.id) !== id && String(item.name || "").trim() !== id && String(item.cn || "").trim() !== id);
    config.cleared = false;
    await saveLimitedMenuConfig(env, config);
    await sendTelegramMessage(env, chatId, before === config.limitedItems.length ? "找不到要刪除的限定項目：" + id : "已刪除限定項目：" + id, buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("停用限定") || t.startsWith("啟用限定") || t.startsWith("启用限定")) {
    const enable = t.startsWith("啟用限定") || t.startsWith("启用限定");
    const id = cleanLimitedId(t.replace(/^停用限定|^啟用限定|^启用限定/, "").trim());
    const config = await getLimitedMenuConfig(env);
    let found = false;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id || String(item.name || "").trim() === id || String(item.cn || "").trim() === id) {
        item.active = enable;
        item.updatedAt = new Date().toISOString();
        found = true;
      }
    });
    config.cleared = false;
    await saveLimitedMenuConfig(env, config);
    await sendTelegramMessage(env, chatId, found ? (enable ? "已啟用限定項目：" : "已停用限定項目：") + id : "找不到限定項目：" + id, buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("新增限定") || t.startsWith("添加限定") || t.startsWith("編輯限定") || t.startsWith("编辑限定")) {
    const editMode = t.startsWith("編輯限定") || t.startsWith("编辑限定");
    const fields = parseLimitedFields(t);
    const config = await getLimitedMenuConfig(env);
    const item = buildLimitedItemFromFields(fields, editMode);

    if (!item.name || !item.cn) {
      await sendTelegramMessage(env, chatId, "資料不完整。至少需要：\n名稱：\n中文：\n\n發送「限定說明」可以查看格式。", null);
      return json({ ok: true });
    }

    if (editMode) {
      const target = cleanLimitedId(fields.id || fields["編號"] || fields["编号"] || fields["id"] || "");
      let updated = false;
      config.limitedItems = config.limitedItems.map(old => {
        if ((target && cleanLimitedId(old.id) === target) || String(old.name || "").trim() === item.name || String(old.cn || "").trim() === item.cn) {
          updated = true;
          return { ...old, ...item, id: old.id || item.id, updatedAt: new Date().toISOString() };
        }
        return old;
      });
      if (!updated) config.limitedItems.unshift(item);
    } else {
      config.limitedItems = config.limitedItems.filter(old => cleanLimitedId(old.id) !== cleanLimitedId(item.id));
      config.limitedItems.unshift(item);
    }

    config.cleared = false;
    await saveLimitedMenuConfig(env, config);
    await sendTelegramMessage(env, chatId, (editMode ? "已更新期間限定：" : "已新增期間限定：") + item.name + "\n編號：" + item.id, buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  await sendTelegramMessage(env, chatId, buildLimitedHelpText(), null);
  return json({ ok: true });
}

async function handleLimitedMenuAction(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;

  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");

  const parts = String(data || "").split(":");
  const action = parts[0];
  const id = cleanLimitedId(parts.slice(1).join(":"));
  const config = await getLimitedMenuConfig(env);

  if (action === "limited_list") {
    await editTelegramMessage(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, "已刷新期間限定列表");
  }

  if (action === "limited_toggle") {
    let found = false;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id) {
        item.active = item.active === false ? true : false;
        item.updatedAt = new Date().toISOString();
        found = true;
      }
    });
    await saveLimitedMenuConfig(env, config);
    await editTelegramMessage(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, found ? "已切換限定狀態" : "找不到項目");
  }

  if (action === "limited_delete") {
    const item = config.limitedItems.find(x => cleanLimitedId(x.id) === id);
    if (!item) return stop(env, cq, "找不到項目");
    await editTelegramMessage(env, chatId, messageId, "確定刪除期間限定？\n\n" + limitedItemLine(item), {
      inline_keyboard: [
        [{ text: "✅ 確認刪除", callback_data: "limited_delete_yes:" + id }],
        [{ text: "取消", callback_data: "limited_list:all" }]
      ]
    });
    return stop(env, cq, "請確認刪除");
  }

  if (action === "limited_delete_yes") {
    config.limitedItems = config.limitedItems.filter(item => cleanLimitedId(item.id) !== id);
    config.cleared = config.limitedItems.length === 0;
    await saveLimitedMenuConfig(env, config);
    await editTelegramMessage(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, "已刪除限定項目");
  }

  return stop(env, cq, "未知限定操作");
}

function isAuthorizedTelegramChat(env, chatId) {
  const allowed = String(env.TELEGRAM_CHAT_ID || "").trim();
  if (!allowed) return true;
  return String(chatId || "").trim() === allowed;
}

async function getLimitedMenuConfig(env) {
  const raw = await env.ORDERS.get(LIMITED_MENU_KEY);
  if (!raw) {
    return {
      limitedItems: [{
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
      }],
      cleared: false,
      updatedAt: "",
      updatedBy: "default"
    };
  }
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object") throw new Error("bad config");
    if (!Array.isArray(config.limitedItems)) config.limitedItems = [];
    return config;
  } catch (_) {
    return { limitedItems: [], cleared: true, updatedAt: new Date().toISOString(), updatedBy: "error" };
  }
}

async function saveLimitedMenuConfig(env, config) {
  config = config || {};
  config.limitedItems = Array.isArray(config.limitedItems) ? config.limitedItems.slice(0, 20) : [];
  config.updatedAt = new Date().toISOString();
  config.updatedBy = "telegram";
  await env.ORDERS.put(LIMITED_MENU_KEY, JSON.stringify(config));
  return config;
}

function parseLimitedFields(text) {
  const fields = {};
  String(text || "").split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([^:：]{1,12})\s*[:：]\s*(.*?)\s*$/);
    if (!m) return;
    const key = String(m[1] || "").trim();
    const value = String(m[2] || "").trim();
    if (key) fields[key] = value;
  });
  return fields;
}

function field(fields, names, fallback = "") {
  for (const name of names) {
    if (fields[name] != null && String(fields[name]).trim() !== "") return String(fields[name]).trim();
  }
  return fallback;
}

function buildLimitedItemFromFields(fields, editMode) {
  const name = field(fields, ["名稱", "名称", "name", "Name"]);
  const cn = field(fields, ["中文", "cn", "CN", "zh"], name || "期間限定");
  const id = cleanLimitedId(field(fields, ["編號", "编号", "id", "ID"], name ? slugLimitedId(name) : ("limited" + Date.now().toString(36).slice(-5))));
  const price = Number(field(fields, ["價格", "价格", "price", "固定價", "固定价"], "0")) || 0;
  const hotPrice = Number(field(fields, ["熱價", "热价", "hot", "hotPrice"], price ? String(price) : "0")) || 0;
  const icedPrice = Number(field(fields, ["凍價", "冻价", "冰價", "冰价", "iced", "icedPrice"], price ? String(price) : "0")) || 0;
  let milk = field(fields, ["奶", "奶類", "奶类", "milk"], "yes");
  milk = !/^(no|false|0|否|不要|不需要|black|無|无)$/i.test(milk);
  let active = field(fields, ["啟用", "启用", "active"], "yes");
  active = !/^(no|false|0|否|停用)$/i.test(active);
  return {
    id,
    active,
    name,
    cn,
    desc: field(fields, ["描述", "desc", "description"], ""),
    bean: field(fields, ["豆子", "豆", "bean", "beans"], "期間限定豆子"),
    flavor: field(fields, ["風味", "风味", "flavor", "tasting"], ""),
    note: field(fields, ["備註", "备注", "note"], ""),
    milk,
    tempMode: field(fields, ["溫度", "温度", "temp", "temperature"], "both"),
    fixedPrice: price,
    hotPrice,
    icedPrice,
    image: field(fields, ["圖片", "图片", "image", "imageUrl"], "./americano-new.jpg"),
    updatedAt: new Date().toISOString()
  };
}

function buildLimitedListText(config) {
  const items = Array.isArray(config.limitedItems) ? config.limitedItems : [];
  const lines = [];
  lines.push("✨ SKY31 期間限定管理");
  lines.push("");
  lines.push("目前項目：" + items.length);
  lines.push("更新時間：" + (config.updatedAt ? formatDateTime(config.updatedAt) : "-") );
  lines.push("");
  if (!items.length) {
    lines.push("目前沒有期間限定項目。");
  } else {
    items.forEach(item => lines.push(limitedItemLine(item)));
  }
  lines.push("");
  lines.push("發送「限定說明」查看新增 / 編輯格式。");
  return lines.join("\n").trim();
}

function limitedItemLine(item) {
  const status = item.active === false ? "停用" : "啟用";
  const price = Number(item.fixedPrice || 0) > 0 ? ("MOP " + Number(item.fixedPrice)) : ("熱 MOP " + Number(item.hotPrice || 0) + " / 凍 MOP " + Number(item.icedPrice || 0));
  return "• [" + status + "] " + (item.name || "-") + "｜" + (item.cn || "-") + "\n  編號：" + cleanLimitedId(item.id) + "｜" + price + "\n  豆子：" + (item.bean || "-") + (item.flavor ? "｜" + item.flavor : "");
}

function buildLimitedListMarkup(config) {
  const rows = [];
  const items = Array.isArray(config.limitedItems) ? config.limitedItems : [];
  items.slice(0, 12).forEach(item => {
    const id = cleanLimitedId(item.id);
    rows.push([
      { text: item.active === false ? "啟用 " + id : "停用 " + id, callback_data: "limited_toggle:" + id },
      { text: "刪除", callback_data: "limited_delete:" + id }
    ]);
  });
  rows.push([{ text: "刷新列表", callback_data: "limited_list:all" }]);
  return { inline_keyboard: rows };
}

function buildLimitedHelpText() {
  return [
    "✨ SKY31 期間限定管理格式",
    "",
    "新增：",
    "新增限定",
    "名稱：Honey Latte",
    "中文：蜂蜜拿鐵",
    "描述：蜂蜜香氣配鮮牛乳，口感柔和。",
    "豆子：Colombia Pink Bourbon",
    "風味：蜂蜜・柑橘・紅茶",
    "熱價：45",
    "凍價：48",
    "奶：yes",
    "溫度：both",
    "圖片：https://...jpg",
    "",
    "其他指令：",
    "限定列表 / /limited",
    "停用限定 編號",
    "啟用限定 編號",
    "刪除限定 編號",
    "清空限定",
    "",
    "備註：圖片暫時支援圖片 URL；直接上傳相片需要下一版接 Cloudflare R2 / Images。"
  ].join("\n");
}

function cleanLimitedId(id) {
  return String(id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
}

function slugLimitedId(s) {
  s = String(s || "limited").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18);
  return s || ("limited" + Date.now().toString(36).slice(-5));
}

async function handleMemberQueryAction(env, cq, data) {
  const sep = data.indexOf(":");
  const action = sep >= 0 ? data.slice(0, sep) : "";
  const arg = sep >= 0 ? data.slice(sep + 1) : "";
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;

  if (action === "member_list") {
    const members = await listTelegramMembers(env);
    await editTelegramMessage(env, chatId, messageId, buildMemberListText(members), buildMemberListMarkup(members));
    return stop(env, cq, "已返回用戶列表");
  }

  if (action === "member_view_active" || action === "member_view_deleted") {
    const phone = normalizePhone(arg);
    if (!phone) return stop(env, cq, "找不到會員電話");

    const deleted = action === "member_view_deleted";
    let member = await getMemberForTelegramView(env, phone, deleted);

    if (!member) return stop(env, cq, "找不到會員資料");

    if (!deleted) {
      member = await enrichMemberStatsForTelegram(env, member);
    }

    await editTelegramMessage(
      env,
      chatId,
      messageId,
      buildMemberDetailText(member, deleted),
      buildMemberDetailReplyMarkup(member, deleted)
    );

    return stop(env, cq, "已載入會員資料");
  }

  return stop(env, cq, "未知會員查詢操作");
}

async function listTelegramMembers(env) {
  const active = await listMembersByPrefix(env, "member:", false);
  const deleted = await listMembersByPrefix(env, "member_deleted:", true);

  const members = active.concat(deleted);
  members.sort((a, b) => {
    if (a._deleted !== b._deleted) return a._deleted ? 1 : -1;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });

  return members;
}

const V128_MEMBER_LIST_LIMIT = 80;

async function listMembersByPrefix(env, prefix, deleted) {
  let cursor = undefined;
  const out = [];

  do {
    const page = await env.ORDERS.list({ prefix, cursor });

    for (const key of (page.keys || [])) {
      const raw = await env.ORDERS.get(key.name);
      if (!raw) continue;

      try {
        const member = JSON.parse(raw);
        if (!member || !member.phone) continue;
        member._deleted = !!deleted;
        out.push(member);
        if (out.length >= V128_MEMBER_LIST_LIMIT) return out;
      } catch (_) {}
    }

    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);

  return out;
}

function buildMemberListText(members) {
  const activeCount = members.filter(m => !m._deleted).length;
  const deletedCount = members.filter(m => m._deleted).length;

  const lines = [];
  lines.push("👥 SKY31 用戶查詢");
  lines.push("");
  lines.push("有效會員：" + activeCount);
  lines.push("已刪除會員：" + deletedCount);
  lines.push("");
  if (!members.length) {
    lines.push("目前未有會員資料。");
  } else {
    lines.push("請點擊下方用戶查看詳細資料。");
    lines.push("最多顯示前 80 位，避免查詢超時。");
  }
  return lines.join("\n").trim();
}

function buildMemberListMarkup(members) {
  const rows = [];

  members.slice(0, 80).forEach(member => {
    const phone = normalizePhone(member.phone);
    const name = member.name || "未命名";
    const deleted = !!member._deleted;
    const label = (deleted ? "🗑️ " : "👤 ") + name + "｜" + phone + (deleted ? "｜已刪除" : "");
    rows.push([{
      text: label.slice(0, 60),
      callback_data: (deleted ? "member_view_deleted:" : "member_view_active:") + phone
    }]);
  });

  if (members.length > 80) {
    rows.push([{ text: "只顯示前 80 位，請到 KV 後台查看完整資料", callback_data: "member_list:all" }]);
  }

  return { inline_keyboard: rows };
}

async function getMemberForTelegramView(env, phone, deleted) {
  const key = deleted ? "member_deleted:" + phone : "member:" + phone;
  const raw = await env.ORDERS.get(key);
  if (!raw) return null;

  try {
    const member = JSON.parse(raw);
    member._deleted = !!deleted;
    return member;
  } catch (_) {
    return null;
  }
}

async function enrichMemberStatsForTelegram(env, member) {
  const phone = normalizePhone(member.phone);
  const prefix = "phone:" + phone + ":";
  let cursor = undefined;
  let totalOrders = 0;
  let totalCups = 0;
  let totalSpent = 0;
  const recentOrders = [];

  do {
    const page = await env.ORDERS.list({ prefix, cursor });

    for (const key of (page.keys || [])) {
      const orderNo = key.name.replace(prefix, "");
      if (!orderNo) continue;

      const raw = await env.ORDERS.get("order:" + orderNo);
      if (!raw) continue;

      let order = null;
      try { order = JSON.parse(raw); } catch (_) { continue; }
      if (!order || normalizePhone(order.phone) !== phone) continue;

      const cups = orderCupsForMemberQuery(order);
      const amount = Number(order.totalAmount || cartTotalForMemberQuery(order.cart) || 0);

      if (order.status !== "cancelled") {
        totalOrders += 1;
        totalCups += cups;
        totalSpent += amount;
      }

      recentOrders.push({
        orderNo: order.orderNo || orderNo,
        status: order.status || "pending",
        createdAt: order.createdAt || "",
        cups,
        totalAmount: amount
      });
    }

    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);

  recentOrders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  return {
    ...member,
    totalOrders,
    totalCups,
    totalSpent: Math.round(totalSpent * 100) / 100,
    recentOrders: recentOrders.slice(0, 5)
  };
}

function buildMemberDetailText(member, deleted = false) {
  const lines = [];
  lines.push("👤 SKY31 會員詳細資料");
  lines.push("");
  lines.push(deleted ? "狀態：已刪除" : "狀態：有效會員");
  lines.push("姓名：" + (member.name || "-"));
  lines.push("電話：" + (member.phone || "-"));
  lines.push("生日：" + (member.birthday || "-"));
  if (member.note) lines.push("備註：" + member.note);
  if (member.createdAt) lines.push("註冊時間：" + formatDateTime(member.createdAt));
  if (member.deletedAt) lines.push("刪除時間：" + formatDateTime(member.deletedAt));
  if (member.restoredAt && !deleted) lines.push("恢復時間：" + formatDateTime(member.restoredAt));
  lines.push("");
  lines.push("累積訂單：" + Number(member.totalOrders || 0));
  lines.push("累積杯數：" + Number(member.totalCups || 0));
  lines.push("累積消費：MOP " + String(Math.round(Number(member.totalSpent || 0) * 100) / 100));

  if (deleted && member.deletedOrders != null) {
    lines.push("已刪除相關訂單：" + Number(member.deletedOrders || 0));
  }

  const recent = Array.isArray(member.recentOrders) ? member.recentOrders : [];
  if (recent.length) {
    lines.push("");
    lines.push("最近訂單：");
    recent.forEach(order => {
      lines.push("#" + order.orderNo + "｜" + statusLabel(order.status) + "｜" + Number(order.cups || 0) + "杯｜MOP " + String(Math.round(Number(order.totalAmount || 0) * 100) / 100));
    });
  }

  lines.push("");
  if (deleted) {
    lines.push("此會員已刪除。可按「恢復賬號」恢復會員。");
  } else {
    lines.push("可按「刪除賬號」刪除會員及相關訂單。");
  }

  return lines.join("\n").trim();
}

function buildMemberDetailReplyMarkup(member, deleted = false) {
  const phone = normalizePhone(member.phone);
  if (deleted) {
    return {
      inline_keyboard: [
        [{ text: "↩️ 恢復賬號", callback_data: "member_restore:" + phone }],
        [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
      ]
    };
  }

  return {
    inline_keyboard: [
      [{ text: "🗑️ 刪除賬號", callback_data: "member_delete:" + phone }],
      [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
    ]
  };
}

function orderCupsForMemberQuery(order) {
  return Array.isArray(order.cart)
    ? order.cart.reduce((sum, item) => sum + Number(item.qty || item.quantity || 1), 0)
    : 0;
}

function cartTotalForMemberQuery(cart) {
  return (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
    const qty = Number(item.qty || item.quantity || 1);
    const unit = Number(item.unitPrice || item.price || 0);
    return sum + Number(item.subtotal || unit * qty || 0);
  }, 0);
}

async function sendTelegramMessage(env, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
}

async function handleMemberAction(env, cq, data) {
  try {
    const sep = data.indexOf(":");
    const action = sep >= 0 ? data.slice(0, sep) : "";
    const phone = normalizePhone(sep >= 0 ? data.slice(sep + 1) : "");

    if (!phone) return stop(env, cq, "找不到會員電話");

    const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
    const messageId = cq.message ? cq.message.message_id : null;

    if (action === "member_delete") {
      const member = await getAnyMember(env, phone);
      if (!member) return stop(env, cq, "找不到會員資料");

      // First click only shows confirm buttons. No deletion yet.
      await editTelegramMessage(
        env,
        chatId,
        messageId,
        buildMemberTelegramText(member, !!member.deletedAt, true),
        {
          inline_keyboard: [
            [
              { text: "✅ 確認刪除", callback_data: "member_delete_confirmed:" + phone },
              { text: "取消", callback_data: "member_cancel_delete:" + phone }
            ],
            [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
          ]
        }
      );

      return stop(env, cq, "請再次確認是否刪除會員");
    }

    if (action === "member_cancel_delete") {
      const member = await getAnyMember(env, phone);
      if (!member) return stop(env, cq, "找不到會員資料");

      await editTelegramMessage(
        env,
        chatId,
        messageId,
        buildMemberTelegramText(member, !!member.deletedAt, false),
        buildMemberReplyMarkup(member, !!member.deletedAt)
      );

      return stop(env, cq, "已取消刪除");
    }

    if (action === "member_delete_confirmed") {
      const activeRaw = await env.ORDERS.get("member:" + phone);
      if (!activeRaw) {
        const deletedRaw = await env.ORDERS.get("member_deleted:" + phone);
        if (deletedRaw) {
          const deleted = JSON.parse(deletedRaw);
          await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(deleted, true, false), buildMemberReplyMarkup(deleted, true));
          return stop(env, cq, "此會員資料已刪除");
        }
        return stop(env, cq, "找不到有效會員資料");
      }

      const member = JSON.parse(activeRaw);

      const deletedOrderResult = await deleteMemberOrders(env, phone);

      member.deletedAt = new Date().toISOString();
      member.deletedBy = "telegram";
      member.updatedAt = member.deletedAt;
      member.deletedOrders = deletedOrderResult.deletedOrders || 0;
      member.deletedOrderNos = deletedOrderResult.orderNos || [];

      // Since related order records are removed, reset visible order statistics.
      member.totalOrders = 0;
      member.totalCups = 0;
      member.totalSpent = 0;
      member.recentOrderNos = [];
      member.lastOrderNo = "";
      member.lastOrderAt = "";

      await env.ORDERS.put("member_deleted:" + phone, JSON.stringify(member));
      await env.ORDERS.delete("member:" + phone);

      await editTelegramMessage(
        env,
        chatId,
        messageId,
        buildMemberTelegramText(member, true, false),
        buildMemberReplyMarkup(member, true)
      );

      return stop(env, cq, "已刪除會員及相關訂單 " + phone);
    }

    if (action === "member_restore") {
      const activeRaw = await env.ORDERS.get("member:" + phone);
      if (activeRaw) {
        const active = JSON.parse(activeRaw);
        await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(active, false, false), buildMemberReplyMarkup(active, false));
        return stop(env, cq, "此會員目前已是有效狀態");
      }

      const deletedRaw = await env.ORDERS.get("member_deleted:" + phone);
      if (!deletedRaw) return stop(env, cq, "沒有可撤回的會員資料");

      const member = JSON.parse(deletedRaw);

      const restoredOrderResult = await restoreMemberOrders(env, phone);

      delete member.deletedAt;
      delete member.deletedBy;
      member.restoredAt = new Date().toISOString();
      member.updatedAt = member.restoredAt;
      member.restoredOrders = restoredOrderResult.restoredOrders || 0;
      member.restoredOrderNos = restoredOrderResult.restoredOrderNos || [];

      // Restore visible member statistics from archived orders.
      member.totalOrders = restoredOrderResult.totalOrders || 0;
      member.totalCups = restoredOrderResult.totalCups || 0;
      member.totalSpent = restoredOrderResult.totalSpent || 0;
      member.recentOrderNos = restoredOrderResult.recentOrderNos || [];
      member.lastOrderNo = restoredOrderResult.lastOrderNo || "";
      member.lastOrderAt = restoredOrderResult.lastOrderAt || "";

      await env.ORDERS.put("member:" + phone, JSON.stringify(member));
      await env.ORDERS.delete("member_deleted:" + phone);

      await editTelegramMessage(
        env,
        chatId,
        messageId,
        buildMemberTelegramText(member, false, false),
        buildMemberReplyMarkup(member, false)
      );

      return stop(env, cq, "已恢復會員及相關訂單 " + phone);
    }

    return stop(env, cq, "未知會員操作");
  } catch (e) {
    try {
      return stop(env, cq, "操作失敗：" + (e.message || "未知錯誤"));
    } catch (_) {
      return json({ ok: false, error: e.message || "member action failed" }, 500);
    }
  }
}


async function deleteMemberOrders(env, phone) {
  phone = normalizePhone(phone);
  const prefix = "phone:" + phone + ":";
  let cursor = undefined;
  let deletedOrders = 0;
  let deletedIndexKeys = 0;
  const orderNos = [];

  do {
    const page = await env.ORDERS.list({ prefix, cursor });
    for (const key of (page.keys || [])) {
      const orderNo = key.name.replace(prefix, "");
      if (!orderNo) continue;
      orderNos.push(orderNo);
    }
    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);

  for (const orderNo of orderNos) {
    const orderKey = "order:" + orderNo;
    const phoneKey = prefix + orderNo;
    const markerKey = "member_ordered:" + phone + ":" + orderNo;

    const orderRaw = await env.ORDERS.get(orderKey);
    const phoneRaw = await env.ORDERS.get(phoneKey);
    const markerRaw = await env.ORDERS.get(markerKey);

    // Archive before deleting active lookup keys, so future restore can rebuild everything.
    if (orderRaw) await env.ORDERS.put("member_deleted_order:" + phone + ":" + orderNo, orderRaw);
    if (phoneRaw != null) await env.ORDERS.put("member_deleted_phone_index:" + phone + ":" + orderNo, phoneRaw);
    if (markerRaw != null) await env.ORDERS.put("member_deleted_order_marker:" + phone + ":" + orderNo, markerRaw);

    await env.ORDERS.delete(orderKey);
    await env.ORDERS.delete(phoneKey);
    await env.ORDERS.delete(markerKey);

    deletedOrders += 1;
    deletedIndexKeys += 2;
  }

  return { deletedOrders, deletedIndexKeys, orderNos };
}

async function restoreMemberOrders(env, phone) {
  phone = normalizePhone(phone);
  const prefix = "member_deleted_order:" + phone + ":";
  let cursor = undefined;
  const orderNos = [];
  let restoredOrders = 0;
  let totalCups = 0;
  let totalSpent = 0;
  const recentOrderNos = [];
  let lastOrderNo = "";
  let lastOrderAt = "";

  do {
    const page = await env.ORDERS.list({ prefix, cursor });
    for (const key of (page.keys || [])) {
      const orderNo = key.name.replace(prefix, "");
      if (!orderNo) continue;
      orderNos.push(orderNo);
    }
    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);

  for (const orderNo of orderNos) {
    const archivedOrderKey = "member_deleted_order:" + phone + ":" + orderNo;
    const archivedPhoneIndexKey = "member_deleted_phone_index:" + phone + ":" + orderNo;
    const archivedMarkerKey = "member_deleted_order_marker:" + phone + ":" + orderNo;

    const orderRaw = await env.ORDERS.get(archivedOrderKey);
    if (!orderRaw) continue;

    await env.ORDERS.put("order:" + orderNo, orderRaw);

    const phoneIndexRaw = await env.ORDERS.get(archivedPhoneIndexKey);
    await env.ORDERS.put("phone:" + phone + ":" + orderNo, phoneIndexRaw != null ? phoneIndexRaw : orderNo);

    const markerRaw = await env.ORDERS.get(archivedMarkerKey);
    await env.ORDERS.put("member_ordered:" + phone + ":" + orderNo, markerRaw != null ? markerRaw : "1");

    let order = null;
    try { order = JSON.parse(orderRaw); } catch (_) { order = null; }

    if (order && order.status !== "cancelled") {
      restoredOrders += 1;
      totalCups += orderCupsForMemberRestore(order);
      totalSpent += Number(order.totalAmount || cartTotalForMemberRestore(order.cart) || 0);
      recentOrderNos.push(orderNo);

      if (!lastOrderAt || String(order.createdAt || "").localeCompare(String(lastOrderAt || "")) > 0) {
        lastOrderAt = order.createdAt || "";
        lastOrderNo = orderNo;
      }
    }

    await env.ORDERS.delete(archivedOrderKey);
    await env.ORDERS.delete(archivedPhoneIndexKey);
    await env.ORDERS.delete(archivedMarkerKey);
  }

  recentOrderNos.sort().reverse();

  return {
    restoredOrders,
    restoredOrderNos: orderNos,
    totalOrders: restoredOrders,
    totalCups,
    totalSpent: Math.round(totalSpent * 100) / 100,
    recentOrderNos: recentOrderNos.slice(0, 10),
    lastOrderNo,
    lastOrderAt
  };
}

function orderCupsForMemberRestore(order) {
  return Array.isArray(order.cart)
    ? order.cart.reduce((sum, item) => sum + Number(item.qty || item.quantity || 1), 0)
    : 0;
}

function cartTotalForMemberRestore(cart) {
  return (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
    const qty = Number(item.qty || item.quantity || 1);
    const unit = Number(item.unitPrice || item.price || 0);
    return sum + Number(item.subtotal || unit * qty || 0);
  }, 0);
}

async function getAnyMember(env, phone) {
  const activeRaw = await env.ORDERS.get("member:" + phone);
  if (activeRaw) {
    try { return JSON.parse(activeRaw); } catch (_) {}
  }

  const deletedRaw = await env.ORDERS.get("member_deleted:" + phone);
  if (deletedRaw) {
    try { return JSON.parse(deletedRaw); } catch (_) {}
  }

  return null;
}

function buildMemberReplyMarkup(member, deleted = false) {
  const phone = normalizePhone(member.phone);
  if (deleted) {
    return {
      inline_keyboard: [
        [{ text: "↩️ 撤回", callback_data: "member_restore:" + phone }],
        [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
      ]
    };
  }

  return {
    inline_keyboard: [
      [{ text: "🗑️ 刪除", callback_data: "member_delete:" + phone }],
      [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
    ]
  };
}

function buildMemberTelegramText(member, deleted = false, confirmingDelete = false) {
  const lines = [];
  lines.push("👤 SKY31 MEMBER");
  lines.push("");

  if (confirmingDelete) {
    lines.push("狀態：等待確認刪除");
  } else {
    lines.push(deleted ? "狀態：已刪除" : "狀態：有效會員");
  }

  lines.push("姓名：" + (member.name || "-"));
  lines.push("電話：" + (member.phone || "-"));
  lines.push("生日：" + (member.birthday || "-"));
  if (member.note) lines.push("備註：" + member.note);
  if (member.createdAt) lines.push("註冊時間：" + formatDateTime(member.createdAt));
  if (member.deletedAt && !confirmingDelete) lines.push("刪除時間：" + formatDateTime(member.deletedAt));
  if (deleted && !confirmingDelete) lines.push("已刪除相關訂單：" + Number(member.deletedOrders || 0));
  if (member.restoredAt && !deleted && !confirmingDelete) lines.push("恢復時間：" + formatDateTime(member.restoredAt));
  if (member.restoredAt && !deleted && !confirmingDelete) lines.push("已恢復相關訂單：" + Number(member.restoredOrders || 0));
  lines.push("");
  lines.push("累積訂單：" + Number(member.totalOrders || 0));
  lines.push("累積杯數：" + Number(member.totalCups || 0));
  lines.push("累積消費：MOP " + String(Math.round(Number(member.totalSpent || 0) * 100) / 100));
  lines.push("");

  if (confirmingDelete) {
    lines.push("請確認是否刪除此會員資料。");
  } else if (deleted) {
    lines.push("此會員已刪除。客戶不能再用此會員登入；如需要可重新註冊。");
  } else {
    lines.push("提示：按刪除後會先進入確認狀態。");
  }

  return lines.join("\n").trim();
}


function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

async function stop(env, cq, text) {
  await answerCallback(env, cq.id, text);
  return json({ ok: true });
}

async function getOrder(env, orderNo, cq) {
  const raw = await env.ORDERS.get("order:" + orderNo);
  if (!raw) {
    await answerCallback(env, cq.id, "找不到訂單");
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    await answerCallback(env, cq.id, "訂單資料異常");
    return null;
  }
}

async function saveAndRefresh(env, cq, order) {
  const now = new Date().toISOString();
  order.updatedAt = now;
  order.statusUpdatedAt = now;

  // V170: keep edited orders long-term. Do not revert to old 14-day TTL when Telegram buttons are pressed.
  await env.ORDERS.put("order:" + order.orderNo, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 3650 });

  await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order), buildReplyMarkup(order));
}

function normalizeStatus(s) {
  if (s === "confirmed") return "confirmed";
  if (s === "making") return "making";
  if (s === "completed") return "completed";
  if (s === "picked_up") return "picked_up";
  return "pending";
}

function clearCancelBackup(order) {
  order.statusBeforeCancel = null;
  order.confirmedAtBeforeCancel = null;
  order.makingAtBeforeCancel = null;
  order.completedAtBeforeCancel = null;
  order.pickedUpAtBeforeCancel = null;
}

function buildReplyMarkup(order) {
  const no = order.orderNo || "";
  const s = order.status || "pending";

  if (s === "cancelled") {
    return { inline_keyboard: [[{ text: "↩️ 恢復訂單 #" + no, callback_data: "restore:" + no }]] };
  }

  if (s === "picked_up") {
    return { inline_keyboard: [[{ text: "↩️ 撤回領取 #" + no, callback_data: "undo_pickup:" + no }]] };
  }

  if (s === "completed") {
    return { inline_keyboard: [
      [
        { text: "☕ 已領取 #" + no, callback_data: "pickup:" + no },
        { text: "↩️ 撤回完成 #" + no, callback_data: "undo_complete:" + no }
      ],
      [{ text: "❌ 取消訂單 #" + no, callback_data: "cancel:" + no }]
    ]};
  }

  if (s === "making") {
    return { inline_keyboard: [
      [
        { text: "✅ 完成訂單 #" + no, callback_data: "complete:" + no },
        { text: "↩️ 撤回製作 #" + no, callback_data: "undo_make:" + no }
      ],
      [{ text: "❌ 取消訂單 #" + no, callback_data: "cancel:" + no }]
    ]};
  }

  if (s === "confirmed") {
    return { inline_keyboard: [
      [
        { text: "👨‍🍳 開始製作 #" + no, callback_data: "make:" + no },
        { text: "↩️ 撤回確認 #" + no, callback_data: "undo_confirm:" + no }
      ],
      [{ text: "❌ 取消訂單 #" + no, callback_data: "cancel:" + no }]
    ]};
  }

  return { inline_keyboard: [[
    { text: "✅ 確認訂單 #" + no, callback_data: "confirm:" + no },
    { text: "❌ 取消訂單 #" + no, callback_data: "cancel:" + no }
  ]] };
}

function buildTelegramText(order) {
  const lines = [];
  const s = order.status || "pending";
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
      lines.push("☕ " + title + " ×" + (item.qty || 1) + (parts.length ? " | " + parts.join(" | ") : ""));
      if (item.note && item.note !== "無備註") lines.push("備註：" + item.note);
      lines.push("");
    });
  } else if (order.orderText) {
    lines.push(order.orderText);
    lines.push("");
  }

  lines.push("────────────");
  lines.push("客人：" + (order.customerName || ""));
  lines.push("電話：" + (order.phone || ""));
  lines.push("");
  lines.push("────────────");
  lines.push(statusIcon(s) + " 狀態：" + statusLabel(s));

  if (order.confirmedAt) lines.push("確認時間：" + formatDateTime(order.confirmedAt));
  if (order.makingAt) lines.push("製作時間：" + formatDateTime(order.makingAt));
  if (order.completedAt) lines.push("完成時間：" + formatDateTime(order.completedAt));
  if (order.pickedUpAt) lines.push("領取時間：" + formatDateTime(order.pickedUpAt));
  if (order.cancelledAt) lines.push("取消時間：" + formatDateTime(order.cancelledAt));
  if (s === "cancelled" && order.statusBeforeCancel) lines.push("取消前狀態：" + statusLabel(order.statusBeforeCancel));

  return lines.join("\n").trim();
}

function statusIcon(s) {
  if (s === "confirmed") return "✅";
  if (s === "making") return "👨‍🍳";
  if (s === "completed") return "✅";
  if (s === "picked_up") return "☕";
  if (s === "cancelled") return "❌";
  return "🧾";
}

function statusLabel(s) {
  if (s === "confirmed") return "已確認訂單";
  if (s === "making") return "製作中";
  if (s === "completed") return "已完成";
  if (s === "picked_up") return "已領取";
  if (s === "cancelled") return "已取消";
  return "已下單，等待確認";
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

async function answerCallback(env, callbackQueryId, text) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !callbackQueryId) return;
    await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/answerCallbackQuery", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || "已收到操作" })
    });
  } catch (_) {}
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !chatId || !messageId) return null;

    const body = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;

    const res = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/editMessageText", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    });

    try { return await res.json(); } catch (_) { return null; }
  } catch (_) {
    return null;
  }
}

function pad2(n) { return String(n).padStart(2, "0"); }
function formatDateTime(d) {
  d = new Date(d);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
