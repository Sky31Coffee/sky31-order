export async function onRequest(context) {
  const method = (context.request && context.request.method) || "GET";

  // V172: universal handler prevents Cloudflare Pages returning
  // "405 Method Not Allowed" for Telegram POST webhook callbacks.
  if (method === "GET" || method === "HEAD") {
    return json({
      ok: true,
      endpoint: "telegram-webhook",
      version: "V234",
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

  if (data.startsWith("maint_")) {
    return handleMaintenanceActionV218(env, cq, data);
  }

  if (data.startsWith("limited_")) {
    return handleLimitedMenuAction(env, cq, data);
  }

  if (
    data.startsWith("member_merge_duplicates:") ||
    data.startsWith("member_merge_confirm:")
  ) {
    return handleMemberDuplicateMergeActionV219(env, cq, data);
  }

  if (
    data.startsWith("member_list:") ||
    data.startsWith("member_view_active:") ||
    data.startsWith("member_view_deleted:")
  ) {
    return handleMemberQueryAction(env, cq, data);
  }

  if (
    data.startsWith("member_edit_birthday:") ||
    data.startsWith("member_edit_cancel:") ||
    data.startsWith("member_tier_menu:") ||
    data.startsWith("member_tier_set:") ||
    data.startsWith("member_refresh:")
  ) {
    return handleMemberAdminEditActionV211(env, cq, data);
  }

  if (
    data.startsWith("member_delete:") ||
    data.startsWith("member_restore:") ||
    data.startsWith("member_cancel_delete:") ||
    data.startsWith("member_delete_confirmed:") ||
    data.startsWith("member_purge:") ||
    data.startsWith("member_purge_cancel:") ||
    data.startsWith("member_purge_confirmed:")
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

  const memberEditDraftV211 = await getMemberEditDraftV211(env, chatId);
  if (memberEditDraftV211) {
    return handleMemberEditDraftTextV211(env, message, text, memberEditDraftV211);
  }

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
    t === "/limited_beans" ||
    t === "/limited_bean_help" ||
    t === "限定" ||
    t === "限定列表" ||
    t === "期間限定" ||
    t === "期间限定" ||
    t === "限定說明" ||
    t === "限定豆子" ||
    t === "限定豆子列表" ||
    t === "限定豆子說明" ||
    t === "限定豆子说明" ||
    t === "限定说明" ||
    t.startsWith("新增限定豆子") ||
    t.startsWith("新增限定") ||
    t.startsWith("添加限定") ||
    t.startsWith("編輯限定豆子") ||
    t.startsWith("编辑限定豆子") ||
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

  if (lower === "/limited_help" || lower === "/limited_bean_help" || t === "限定說明" || t === "限定说明" || t === "限定豆子說明" || t === "限定豆子说明") {
    await sendTelegramMessage(env, chatId, buildLimitedHelpText(), null);
    return json({ ok: true });
  }

  if (lower === "/limited" || lower === "/limited_beans" || t === "限定" || t === "限定列表" || t === "限定豆子" || t === "限定豆子列表" || t === "期間限定" || t === "期间限定") {
    const config = await getLimitedMenuConfig(env);
    await sendTelegramMessage(env, chatId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("清空限定")) {
    const config = await saveLimitedMenuConfig(env, { limitedItems: [], cleared: true, updatedAt: new Date().toISOString(), updatedBy: "telegram" });
    await sendTelegramMessage(env, chatId, "已清空所有限定豆子。\n網站會顯示敬請期待文案。", buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("刪除限定") || t.startsWith("删除限定")) {
    const id = cleanLimitedId(t.replace(/^刪除限定|^删除限定/, "").trim());
    const config = await getLimitedMenuConfig(env);
    const before = config.limitedItems.length;
    config.limitedItems = config.limitedItems.filter(item => cleanLimitedId(item.id) !== id && String(item.name || "").trim() !== id && String(item.cn || "").trim() !== id);
    config.cleared = false;
    await saveLimitedMenuConfig(env, config);
    await sendTelegramMessage(env, chatId, before === config.limitedItems.length ? "找不到要刪除的限定豆子：" + id : "已刪除限定豆子：" + id, buildLimitedListMarkup(config));
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
    await sendTelegramMessage(env, chatId, (editMode ? "已更新限定豆子：" : "已新增限定豆子：") + item.name + "\n編號：" + item.id, buildLimitedListMarkup(config));
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
    return stop(env, cq, found ? "已切換限定豆子狀態" : "找不到項目");
  }

  if (action === "limited_delete") {
    const item = config.limitedItems.find(x => cleanLimitedId(x.id) === id);
    if (!item) return stop(env, cq, "找不到項目");
    await editTelegramMessage(env, chatId, messageId, "確定刪除限定豆子？\n\n" + limitedItemLine(item), {
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
    return stop(env, cq, "已刪除限定豆子");
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
      limitedItems: [],
      cleared: true,
      updatedAt: "",
      updatedBy: "default-empty"
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
  // V181: Limited is bean-only, not a standalone drink.
  // Required: 名稱 / 豆子. Optional: 中文, 風味, 描述/介紹, 備註, 編號, 啟用.
  const rawName = field(fields, ["名稱", "名称", "名字", "name", "Name", "豆子", "豆", "bean", "beans"]);
  const beanName = String(rawName || "").trim();
  const cn = field(fields, ["中文", "cn", "CN", "zh"], beanName || "期間限定豆子");
  const id = cleanLimitedId(field(fields, ["編號", "编号", "id", "ID"], beanName ? slugLimitedId(beanName) : ("bean" + Date.now().toString(36).slice(-5))));
  let active = field(fields, ["啟用", "启用", "active"], "yes");
  active = !/^(no|false|0|否|停用)$/i.test(active);

  return {
    id,
    type: "bean",
    active,
    name: beanName,
    cn,
    bean: beanName,
    flavor: field(fields, ["風味", "风味", "flavor", "tasting"], ""),
    desc: field(fields, ["描述", "介紹", "介绍", "desc", "description"], ""),
    note: field(fields, ["備註", "备注", "note"], ""),
    surcharge: 5,
    limitedSurcharge: 5,
    updatedAt: new Date().toISOString()
  };
}

function buildLimitedListText(config) {
  const items = Array.isArray(config.limitedItems) ? config.limitedItems : [];
  const lines = [];
  lines.push("✨ SKY31 限定豆子管理");
  lines.push("");
  lines.push("目前豆子：" + items.length);
  lines.push("更新時間：" + (config.updatedAt ? formatDateTime(config.updatedAt) : "-") );
  lines.push("");
  if (!items.length) {
    lines.push("目前沒有上架限定豆子。");
  } else {
    items.forEach(item => lines.push(limitedItemLine(item)));
  }
  lines.push("");
  lines.push("發送「限定豆子說明」查看新增 / 編輯格式。");
  return lines.join("\n").trim();
}

function limitedItemLine(item) {
  const status = item.active === false ? "停用" : "啟用";
  const surcharge = Number(item.surcharge || item.limitedSurcharge || 5) || 5;
  return [
    "• [" + status + "] " + (item.bean || item.name || "-"),
    "  編號：" + cleanLimitedId(item.id) + "｜限定豆子 +MOP " + surcharge,
    "  風味：" + (item.flavor || "-"),
    (item.note || item.desc) ? "  備註：" + (item.note || item.desc) : ""
  ].filter(Boolean).join("\n");
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
    "✨ SKY31 限定豆子管理",
    "",
    "用途：",
    "限定豆子只會出現在各咖啡品項的「豆子選擇」內，",
    "不是單獨飲品，不需要熱價、凍價、奶類或圖片。",
    "",
    "新增格式：",
    "新增限定豆子",
    "名稱：Ethiopia Guji",
    "中文：埃塞俄比亞 Guji",
    "風味：莓果・白花・柑橘",
    "描述：明亮花香，酸甜乾淨，適合想試新豆的客人。",
    "",
    "編輯格式：",
    "編輯限定豆子",
    "編號：ethiopia-guji",
    "名稱：Ethiopia Guji",
    "中文：埃塞俄比亞 Guji",
    "風味：莓果・白花・柑橘",
    "描述：明亮花香，酸甜乾淨。",
    "",
    "其他指令：",
    "限定豆子列表 / /limited_beans",
    "停用限定 編號",
    "啟用限定 編號",
    "刪除限定 編號",
    "清空限定",
    "",
    "價格規則：客人選擇任何限定豆子，系統會自動 +MOP 5。"
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

    // V221: after duplicate merge, the user may click a button generated before cleanup.
    // Retry both active/deleted pools by last 8 digits before failing.
    if (!member && !deleted) member = await getMemberForTelegramView(env, phone, true);
    if (!member && deleted) member = await getMemberForTelegramView(env, phone, false);

    if (!member) {
      const members = await listTelegramMembers(env);
      await editTelegramMessage(env, chatId, messageId, buildMemberListText(members), buildMemberListMarkup(members));
      return stop(env, cq, "舊按鈕已失效，已重新整理會員列表，請再點一次");
    }

    const actualDeleted = !!member._deleted;
    if (!actualDeleted) {
      member = await enrichMemberStatsForTelegram(env, member);
    }

    await editTelegramMessage(
      env,
      chatId,
      messageId,
      buildMemberDetailText(member, !!member._deleted),
      buildMemberDetailReplyMarkup(member, !!member._deleted)
    );

    return stop(env, cq, "已載入會員資料");
  }

  return stop(env, cq, "未知會員查詢操作");
}

async function listTelegramMembers(env) {
  const active = await listMembersByPrefix(env, "member:", false);
  const deleted = await listMembersByPrefix(env, "member_deleted:", true);

  let members = active.concat(deleted);
  members = dedupeMembersForListV219(members);

  members.sort((a, b) => {
    if (a._deleted !== b._deleted) return a._deleted ? 1 : -1;
    return memberRecordTimeV219(b) - memberRecordTimeV219(a);
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
        member._kvKey = key.name;
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
  const duplicateHidden = members.reduce((sum, m) => sum + Math.max(0, Number(m._duplicateCount || 1) - 1), 0);
  if (duplicateHidden > 0) {
    lines.push("已自動合併顯示重複電話會員：" + duplicateHidden + " 個 alias");
    lines.push("可在功能表按「合併重複會員」清理多餘 alias。");
    lines.push("");
  }
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
    const rawPhone = normalizePhone(member.phone);
    const lookupPhone = memberLookupPhoneV221(member);
    // V237: show the phone exactly as stored/input; do not auto-prefix 853.
    const displayPhone = rawPhone;
    const name = member.name || "未命名";
    const deleted = !!member._deleted;
    const label = (deleted ? "🗑️ " : "👤 ") + name + "｜" + displayPhone + (deleted ? "｜已刪除" : "");
    rows.push([{
      text: label.slice(0, 60),
      callback_data: (deleted ? "member_view_deleted:" : "member_view_active:") + lookupPhone
    }]);
  });

  if (members.length > 80) {
    rows.push([{ text: "只顯示前 80 位，請到 KV 後台查看完整資料", callback_data: "member_list:all" }]);
  }

  return { inline_keyboard: rows };
}

async function getMemberForTelegramView(env, phone, deleted) {
  phone = normalizePhone(phone);
  if (!phone) return null;

  const lookup8 = phone.length >= 8 ? phone.slice(-8) : phone;
  const primaryPrefix = deleted ? "member_deleted:" : "member:";
  const fallbackPrefixes = deleted ? ["member_deleted:", "member:"] : ["member:", "member_deleted:"];

  function candidatePhonesFromV221(p) {
    const s = normalizePhone(p);
    const last8 = s.length >= 8 ? s.slice(-8) : s;
    const out = [];
    if (s) out.push(s);
    if (last8) {
      out.push(last8);
      out.push("853" + last8);
    }
    return Array.from(new Set(out.filter(Boolean)));
  }

  // 1) Try direct keys first.
  for (const prefix of fallbackPrefixes) {
    for (const p of candidatePhonesFromV221(phone)) {
      const key = prefix + p;
      const raw = await env.ORDERS.get(key);
      if (!raw) continue;
      try {
        const member = JSON.parse(raw);
        const storedPhone = normalizePhone(member.phone || p);
        if (
          samePhoneForMemberLookup(storedPhone, phone) ||
          storedPhone.slice(-8) === lookup8 ||
          normalizePhone(p).slice(-8) === lookup8
        ) {
          member._deleted = prefix === "member_deleted:";
          member._kvKey = key;
          return member;
        }
      } catch (_) {}
    }
  }

  // 2) Full scan fallback by last 8 digits. This is essential after merge cleanup
  // where member:xxxx alias may be deleted and only member:853xxxx remains.
  for (const prefix of fallbackPrefixes) {
    let cursor = undefined;
    do {
      const page = await env.ORDERS.list({ prefix, cursor });
      for (const key of (page.keys || [])) {
        const keyPhone = normalizePhone(key.name.replace(prefix, ""));
        const raw = await env.ORDERS.get(key.name);
        if (!raw) continue;
        try {
          const member = JSON.parse(raw);
          const storedPhone = normalizePhone(member.phone || keyPhone);
          if (
            storedPhone.slice(-8) === lookup8 ||
            keyPhone.slice(-8) === lookup8 ||
            samePhoneForMemberLookup(storedPhone, phone) ||
            samePhoneForMemberLookup(keyPhone, phone)
          ) {
            member.phone = storedPhone || keyPhone || phone;
            member._deleted = prefix === "member_deleted:";
            member._kvKey = key.name;
            return member;
          }
        } catch (_) {}
      }

      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor);
  }

  return null;
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

      if (sky31TelegramSuccessfulOrderV199(order)) {
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

    if (order && sky31TelegramSuccessfulOrderV199(order)) {
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
  try { await recalcMemberFromOrdersV199(env, order); } catch (_) {}

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
  if (bean.indexOf("Limited｜") === 0 || bean.indexOf("Limited|") === 0 || bean.includes("限定豆子")) return "✨";
  if (bean.includes("淺烘") || bean.includes("浅烘")) return "🌸";
  if (bean.includes("中深烘") || bean.includes("拼配")) return "🍫";
  return "☕";
}

function cleanBeanName(bean) {
  const s = String(bean || "");
  if (s.indexOf("Limited｜") === 0 || s.indexOf("Limited|") === 0) {
    const parts = s.includes("｜") ? s.split("｜") : s.split("|");
    const name = parts[1] || "期間限定豆子";
    return name + "（限定豆子 +MOP 5）";
  }
  return s.split("|")[0].split("｜")[0].trim();
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


/* V182: interactive Limited Bean input templates and edit templates.
   These overrides keep Limited Beans as bean options only, not standalone drinks. */

isLimitedMenuCommand = function(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "/limited" ||
    t === "/limited_help" ||
    t === "/limited_beans" ||
    t === "/limited_bean_help" ||
    t === "限定" ||
    t === "限定列表" ||
    t === "限定豆子" ||
    t === "限定豆子列表" ||
    t === "限定豆子說明" ||
    t === "限定豆子说明" ||
    t === "限定說明" ||
    t === "限定说明" ||
    t === "新增豆子" ||
    t === "新增限定豆子" ||
    t === "新增限定" ||
    t === "添加豆子" ||
    t === "添加限定豆子" ||
    t === "編輯豆子" ||
    t === "编辑豆子" ||
    t === "編輯限定豆子" ||
    t === "编辑限定豆子" ||
    t.startsWith("新增豆子") ||
    t.startsWith("新增限定豆子") ||
    t.startsWith("新增限定") ||
    t.startsWith("添加豆子") ||
    t.startsWith("添加限定") ||
    t.startsWith("編輯豆子") ||
    t.startsWith("编辑豆子") ||
    t.startsWith("編輯限定豆子") ||
    t.startsWith("编辑限定豆子") ||
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

handleLimitedMenuTextCommand = async function(env, message, text) {
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;

  if (!isAuthorizedTelegramChat(env, chatId)) {
    await sendTelegramMessage(env, chatId, "沒有權限修改 Sky31 限定豆子。", null);
    return json({ ok: true });
  }

  const t = String(text || "").trim();
  const lower = t.toLowerCase();

  if (
    lower === "/limited_help" ||
    lower === "/limited_bean_help" ||
    t === "限定說明" ||
    t === "限定说明" ||
    t === "限定豆子說明" ||
    t === "限定豆子说明"
  ) {
    await sendTelegramMessage(env, chatId, buildLimitedHelpText(), buildLimitedHelpMarkupV182());
    return json({ ok: true });
  }

  if (
    lower === "/limited" ||
    lower === "/limited_beans" ||
    t === "限定" ||
    t === "限定列表" ||
    t === "限定豆子" ||
    t === "限定豆子列表"
  ) {
    const config = await getLimitedMenuConfig(env);
    await sendTelegramMessage(env, chatId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (/^(新增豆子|新增限定豆子|新增限定|添加豆子|添加限定豆子|添加限定)$/i.test(t)) {
    await sendTelegramMessage(env, chatId, buildLimitedAddTemplateText(), buildLimitedForceReplyMarkupV182("請填寫後整段傳送"));
    return json({ ok: true });
  }

  if (/^(編輯豆子|编辑豆子|編輯限定豆子|编辑限定豆子|編輯限定|编辑限定)$/i.test(t)) {
    const config = await getLimitedMenuConfig(env);
    await sendTelegramMessage(env, chatId, "請先在下面列表按「編輯格式」，或輸入：\n編輯限定豆子 編號\n\n" + buildLimitedListText(config), buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  const editIdOnly = t.match(/^(編輯豆子|编辑豆子|編輯限定豆子|编辑限定豆子|編輯限定|编辑限定)\s+(.+)$/i);
  if (editIdOnly && !t.includes("：") && !t.includes(":")) {
    const config = await getLimitedMenuConfig(env);
    const id = cleanLimitedId(editIdOnly[2] || "");
    const item = findLimitedItemV182(config, id);
    if (!item) {
      await sendTelegramMessage(env, chatId, "找不到限定豆子：" + id + "\n請發送「限定豆子列表」查看編號。", buildLimitedListMarkup(config));
    } else {
      await sendTelegramMessage(env, chatId, buildLimitedEditTemplateText(item), buildLimitedForceReplyMarkupV182("請修改後整段傳送"));
    }
    return json({ ok: true });
  }

  if (t.startsWith("清空限定")) {
    const config = await saveLimitedMenuConfig(env, { limitedItems: [], cleared: true, updatedAt: new Date().toISOString(), updatedBy: "telegram" });
    await sendTelegramMessage(env, chatId, "已清空所有限定豆子。\n網站會顯示：下一支驚喜豆單正在準備中，敬請期待。", buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("刪除限定") || t.startsWith("删除限定")) {
    const id = cleanLimitedId(t.replace(/^刪除限定|^删除限定/, "").trim());
    const config = await getLimitedMenuConfig(env);
    const before = config.limitedItems.length;
    config.limitedItems = config.limitedItems.filter(item => cleanLimitedId(item.id) !== id && String(item.name || "").trim() !== id && String(item.cn || "").trim() !== id);
    config.cleared = config.limitedItems.length === 0;
    await saveLimitedMenuConfig(env, config);
    await sendTelegramMessage(env, chatId, before === config.limitedItems.length ? "找不到要刪除的限定豆子：" + id : "已刪除限定豆子：" + id, buildLimitedListMarkup(config));
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
    config.cleared = config.limitedItems.length === 0;
    await saveLimitedMenuConfig(env, config);
    await sendTelegramMessage(env, chatId, found ? (enable ? "已啟用限定豆子：" : "已停用限定豆子：") + id : "找不到限定豆子：" + id, buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("新增豆子") || t.startsWith("新增限定豆子") || t.startsWith("新增限定") || t.startsWith("添加豆子") || t.startsWith("添加限定") || t.startsWith("編輯豆子") || t.startsWith("编辑豆子") || t.startsWith("編輯限定豆子") || t.startsWith("编辑限定豆子") || t.startsWith("編輯限定") || t.startsWith("编辑限定")) {
    const editMode = t.startsWith("編輯") || t.startsWith("编辑");
    const fields = parseLimitedFields(t);
    const hasFields = Object.keys(fields).length > 0;

    if (!hasFields) {
      await sendTelegramMessage(env, chatId, editMode ? buildLimitedHelpText() : buildLimitedAddTemplateText(), buildLimitedForceReplyMarkupV182("請填寫後整段傳送"));
      return json({ ok: true });
    }

    const config = await getLimitedMenuConfig(env);
    const item = buildLimitedItemFromFields(fields, editMode);

    if (!item.name) {
      await sendTelegramMessage(env, chatId, "資料不完整，至少需要「名稱」。\n\n" + buildLimitedAddTemplateText(), buildLimitedForceReplyMarkupV182("請填寫後整段傳送"));
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
    await sendTelegramMessage(env, chatId, (editMode ? "已更新限定豆子：" : "已新增限定豆子：") + item.name + "\n編號：" + item.id + "\n網站會自動更新 Landing page 及豆子選項。", buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  await sendTelegramMessage(env, chatId, buildLimitedHelpText(), buildLimitedHelpMarkupV182());
  return json({ ok: true });
}

handleLimitedMenuAction = async function(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;

  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");

  const parts = String(data || "").split(":");
  const action = parts[0];
  const id = cleanLimitedId(parts.slice(1).join(":"));
  const config = await getLimitedMenuConfig(env);

  if (action === "limited_add_template") {
    await sendTelegramMessage(env, chatId, buildLimitedAddTemplateText(), buildLimitedForceReplyMarkupV182("請填寫後整段傳送"));
    return stop(env, cq, "已提供新增格式");
  }

  if (action === "limited_help") {
    await sendTelegramMessage(env, chatId, buildLimitedHelpText(), buildLimitedHelpMarkupV182());
    return stop(env, cq, "已提供說明");
  }

  if (action === "limited_edit_template") {
    const item = findLimitedItemV182(config, id);
    if (!item) return stop(env, cq, "找不到限定豆子");
    await sendTelegramMessage(env, chatId, buildLimitedEditTemplateText(item), buildLimitedForceReplyMarkupV182("請修改後整段傳送"));
    return stop(env, cq, "已提供編輯格式");
  }

  if (action === "limited_list") {
    await editTelegramMessage(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, "已刷新限定豆子列表");
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
    config.cleared = config.limitedItems.length === 0;
    await saveLimitedMenuConfig(env, config);
    await editTelegramMessage(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, found ? "已切換限定豆子狀態" : "找不到豆子");
  }

  if (action === "limited_delete") {
    const item = config.limitedItems.find(x => cleanLimitedId(x.id) === id);
    if (!item) return stop(env, cq, "找不到豆子");
    await editTelegramMessage(env, chatId, messageId, "確定刪除限定豆子？\n\n" + limitedItemLine(item), {
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
    return stop(env, cq, "已刪除限定豆子");
  }

  return stop(env, cq, "未知限定操作");
}

function findLimitedItemV182(config, id) {
  id = cleanLimitedId(id);
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  return items.find(item =>
    cleanLimitedId(item.id) === id ||
    cleanLimitedId(item.name) === id ||
    cleanLimitedId(item.bean) === id ||
    cleanLimitedId(item.cn) === id
  );
}

function buildLimitedAddTemplateText() {
  return [
    "➕ 新增限定豆子",
    "",
    "請複製下面格式，填好後整段傳送：",
    "",
    "新增限定豆子",
    "名稱：",
    "中文：",
    "風味：",
    "描述：",
    "備註：",
    "",
    "例子：",
    "新增限定豆子",
    "名稱：Ethiopia Guji",
    "中文：埃塞俄比亞 Guji",
    "風味：莓果・白花・柑橘",
    "描述：明亮花香，酸甜乾淨，適合想試新豆的客人。",
    "備註：限時供應，售完即止。",
    "",
    "價格：客人選擇此限定豆子時，自動 +MOP 5。"
  ].join("\n");
}

function buildLimitedEditTemplateText(item) {
  item = item || {};
  return [
    "✏️ 編輯限定豆子",
    "",
    "請修改下面資料後，整段傳送：",
    "",
    "編輯限定豆子",
    "編號：" + cleanLimitedId(item.id),
    "名稱：" + (item.name || item.bean || ""),
    "中文：" + (item.cn || ""),
    "風味：" + (item.flavor || ""),
    "描述：" + (item.desc || ""),
    "備註：" + (item.note || ""),
    "",
    "價格：限定豆子固定自動 +MOP 5。"
  ].join("\n");
}

buildLimitedHelpText = function() {
  return [
    "✨ SKY31 限定豆子管理",
    "",
    "用途：",
    "限定豆子只會出現在 Landing page 及各咖啡品項的「豆子選擇」內。",
    "它不是單獨飲品，不需要熱價、凍價、奶類或圖片。",
    "",
    "可輸入：",
    "新增限定豆子",
    "編輯限定豆子 編號",
    "限定豆子列表",
    "",
    "新增資料欄位：",
    "名稱：豆子名稱，會顯示在豆子選項",
    "中文：中文名稱，會顯示在頁面輔助文字",
    "風味：風味描述，會顯示在 Landing page 和選項內",
    "描述：簡短介紹，會顯示在頁面",
    "備註：例如限時供應、售完即止",
    "",
    "價格規則：",
    "客人選擇任何限定豆子，系統會自動 +MOP 5。"
  ].join("\n");
}

buildLimitedListText = function(config) {
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  const lines = [];
  lines.push("✨ SKY31 限定豆子管理");
  lines.push("");
  lines.push("目前豆子：" + items.length);
  lines.push("更新時間：" + (config && config.updatedAt ? formatDateTime(config.updatedAt) : "-"));
  lines.push("");
  if (!items.length) {
    lines.push("目前沒有上架限定豆子。");
    lines.push("網站會顯示：下一支驚喜豆單正在準備中，敬請期待。");
  } else {
    items.forEach(item => lines.push(limitedItemLine(item)));
  }
  lines.push("");
  lines.push("按「新增豆子格式」或發送「新增限定豆子」即可開始填寫。");
  return lines.join("\n").trim();
}

limitedItemLine = function(item) {
  const status = item.active === false ? "停用" : "啟用";
  const surcharge = Number(item.surcharge || item.limitedSurcharge || 5) || 5;
  return [
    "• [" + status + "] " + (item.bean || item.name || "-"),
    "  編號：" + cleanLimitedId(item.id) + "｜選用 +MOP " + surcharge,
    "  中文：" + (item.cn || "-"),
    "  風味：" + (item.flavor || "-"),
    item.desc ? "  描述：" + item.desc : "",
    item.note ? "  備註：" + item.note : ""
  ].filter(Boolean).join("\n");
}

buildLimitedListMarkup = function(config) {
  const rows = [];
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];

  rows.push([
    { text: "➕ 新增豆子格式", callback_data: "limited_add_template:all" },
    { text: "📋 說明", callback_data: "limited_help:all" }
  ]);

  items.slice(0, 10).forEach(item => {
    const id = cleanLimitedId(item.id);
    rows.push([{ text: "✏️ 編輯格式 " + id, callback_data: "limited_edit_template:" + id }]);
    rows.push([
      { text: item.active === false ? "啟用 " + id : "停用 " + id, callback_data: "limited_toggle:" + id },
      { text: "刪除", callback_data: "limited_delete:" + id }
    ]);
  });

  rows.push([{ text: "刷新列表", callback_data: "limited_list:all" }]);
  return { inline_keyboard: rows };
}

function buildLimitedHelpMarkupV182() {
  return {
    inline_keyboard: [
      [{ text: "➕ 新增豆子格式", callback_data: "limited_add_template:all" }],
      [{ text: "📋 查看限定豆子列表", callback_data: "limited_list:all" }]
    ]
  };
}

function buildLimitedForceReplyMarkupV182(placeholder) {
  return {
    force_reply: true,
    input_field_placeholder: placeholder || "請填寫限定豆子資料"
  };
}

buildLimitedItemFromFields = function(fields, editMode) {
  const rawName = field(fields, ["名稱", "名称", "名字", "name", "Name", "豆子", "豆", "bean", "beans"]);
  const beanName = String(rawName || "").trim();
  const cn = field(fields, ["中文", "cn", "CN", "zh"], beanName || "期間限定豆子");
  const id = cleanLimitedId(field(fields, ["編號", "编号", "id", "ID"], beanName ? slugLimitedId(beanName) : ("bean" + Date.now().toString(36).slice(-5))));
  let active = field(fields, ["啟用", "启用", "active"], "yes");
  active = !/^(no|false|0|否|停用)$/i.test(active);

  return {
    id,
    type: "bean",
    active,
    name: beanName,
    cn,
    bean: beanName,
    flavor: field(fields, ["風味", "风味", "flavor", "tasting"], ""),
    desc: field(fields, ["描述", "介紹", "介绍", "desc", "description"], ""),
    note: field(fields, ["備註", "备注", "note"], ""),
    surcharge: 5,
    limitedSurcharge: 5,
    updatedAt: new Date().toISOString()
  };
}


/* V183: Step-by-step Telegram wizard for Limited Beans.
   No bulk format is shown to the user. The bot asks one field at a time, with Back / Cancel / Confirm. */

const LIMITED_BEAN_DRAFT_PREFIX_V183 = "sky31:limited_bean_draft:v183:";
const LIMITED_BEAN_STEPS_V183 = [
  {
    key: "name",
    title: "請輸入限定豆子名稱",
    hint: "例如：Ethiopia Guji / Colombia Pink Bourbon",
    required: true
  },
  {
    key: "cn",
    title: "請輸入中文顯示名稱",
    hint: "例如：埃塞俄比亞 Guji。也可以按「略過」。",
    required: false
  },
  {
    key: "flavor",
    title: "請輸入風味描述",
    hint: "例如：莓果・白花・柑橘",
    required: true
  },
  {
    key: "desc",
    title: "請輸入簡短介紹",
    hint: "例如：明亮花香，酸甜乾淨，適合想試新豆的客人。也可以按「略過」。",
    required: false
  },
  {
    key: "note",
    title: "請輸入備註",
    hint: "例如：限時供應，售完即止。也可以按「略過」。",
    required: false
  }
];

function limitedDraftKeyV183(chatId) {
  return LIMITED_BEAN_DRAFT_PREFIX_V183 + String(chatId);
}

async function getLimitedDraftV183(env, chatId) {
  try {
    const raw = await env.ORDERS.get(limitedDraftKeyV183(chatId));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function saveLimitedDraftV183(env, chatId, draft) {
  draft.updatedAt = new Date().toISOString();
  await env.ORDERS.put(limitedDraftKeyV183(chatId), JSON.stringify(draft), { expirationTtl: 60 * 60 * 2 });
}

async function clearLimitedDraftV183(env, chatId) {
  try { await env.ORDERS.delete(limitedDraftKeyV183(chatId)); } catch (_) {}
}

function isBotCommandListV183(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "/start" ||
    t === "/help" ||
    t === "help" ||
    t === "指令" ||
    t === "功能" ||
    t === "功能列表" ||
    t === "菜單" ||
    t === "菜单" ||
    t === "bot" ||
    t === "管理"
  );
}

isLimitedMenuCommand = function(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    isBotCommandListV183(t) ||
    t === "/limited" ||
    t === "/limited_help" ||
    t === "/limited_beans" ||
    t === "/limited_bean_help" ||
    t === "限定" ||
    t === "限定列表" ||
    t === "限定豆子" ||
    t === "限定豆子列表" ||
    t === "限定豆子說明" ||
    t === "限定豆子说明" ||
    t === "限定說明" ||
    t === "限定说明" ||
    t === "新增豆子" ||
    t === "新增限定豆子" ||
    t === "新增限定" ||
    t === "添加豆子" ||
    t === "添加限定豆子" ||
    t === "編輯豆子" ||
    t === "编辑豆子" ||
    t === "編輯限定豆子" ||
    t === "编辑限定豆子" ||
    t.startsWith("編輯限定豆子 ") ||
    t.startsWith("编辑限定豆子 ") ||
    t.startsWith("編輯豆子 ") ||
    t.startsWith("编辑豆子 ") ||
    t.startsWith("刪除限定") ||
    t.startsWith("删除限定") ||
    t.startsWith("停用限定") ||
    t.startsWith("啟用限定") ||
    t.startsWith("启用限定") ||
    t.startsWith("清空限定")
  );
}

handleTelegramTextCommand = async function(env, message) {
  const text = String(message.text || "").trim();
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;

  const activeDraft = await getLimitedDraftV183(env, chatId);
  if (activeDraft && !isBotCommandListV183(text) && !isMemberQueryCommand(text) && !isHardLimitedCommandV183(text)) {
    return handleLimitedWizardTextV183(env, message, text, activeDraft);
  }

  if (isBotCommandListV183(text)) {
    await sendTelegramMessage(env, chatId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
    return json({ ok: true });
  }

  if (isLimitedMenuCommand(text)) {
    return handleLimitedMenuTextCommand(env, message, text);
  }

  if (!isMemberQueryCommand(text)) {
    return json({ ok: true });
  }

  const members = await listTelegramMembers(env);
  await sendTelegramMessage(env, chatId, buildMemberListText(members), buildMemberListMarkup(members));
  return json({ ok: true });
}

function isHardLimitedCommandV183(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "取消" ||
    t === "cancel" ||
    t === "新增豆子" ||
    t === "新增限定豆子" ||
    t === "新增限定" ||
    t === "限定豆子列表" ||
    t === "/limited_beans" ||
    t.startsWith("編輯限定豆子 ") ||
    t.startsWith("编辑限定豆子 ") ||
    t.startsWith("編輯豆子 ") ||
    t.startsWith("编辑豆子 ")
  );
}

handleLimitedMenuTextCommand = async function(env, message, text) {
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;

  if (!isAuthorizedTelegramChat(env, chatId)) {
    await sendTelegramMessage(env, chatId, "沒有權限修改 Sky31 限定豆子。", null);
    return json({ ok: true });
  }

  const t = String(text || "").trim();
  const lower = t.toLowerCase();

  if (lower === "/limited" || lower === "/limited_beans" || t === "限定" || t === "限定列表" || t === "限定豆子" || t === "限定豆子列表") {
    const config = await getLimitedMenuConfig(env);
    await sendTelegramMessage(env, chatId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (lower === "/limited_help" || lower === "/limited_bean_help" || t === "限定說明" || t === "限定说明" || t === "限定豆子說明" || t === "限定豆子说明") {
    await sendTelegramMessage(env, chatId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
    return json({ ok: true });
  }

  if (/^(新增豆子|新增限定豆子|新增限定|添加豆子|添加限定豆子|添加限定)$/i.test(t)) {
    return startLimitedWizardV183(env, chatId, "add", null);
  }

  const editMatch = t.match(/^(編輯豆子|编辑豆子|編輯限定豆子|编辑限定豆子|編輯限定|编辑限定)\s+(.+)$/i);
  if (editMatch) {
    const config = await getLimitedMenuConfig(env);
    const item = findLimitedItemV183(config, editMatch[2] || "");
    if (!item) {
      await sendTelegramMessage(env, chatId, "找不到限定豆子：" + (editMatch[2] || "") + "\n請先打開「限定豆子列表」選擇要編輯的豆子。", buildLimitedListMarkup(config));
      return json({ ok: true });
    }
    return startLimitedWizardV183(env, chatId, "edit", item);
  }

  if (/^(編輯豆子|编辑豆子|編輯限定豆子|编辑限定豆子|編輯限定|编辑限定)$/i.test(t)) {
    const config = await getLimitedMenuConfig(env);
    await sendTelegramMessage(env, chatId, "請選擇要編輯的限定豆子：", buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("清空限定")) {
    await clearLimitedDraftV183(env, chatId);
    const config = await saveLimitedMenuConfig(env, { limitedItems: [], cleared: true, updatedAt: new Date().toISOString(), updatedBy: "telegram" });
    await sendTelegramMessage(env, chatId, "已清空所有限定豆子。\n網站會顯示：下一支驚喜豆單正在準備中，敬請期待。", buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("刪除限定") || t.startsWith("删除限定")) {
    const id = cleanLimitedId(t.replace(/^刪除限定|^删除限定/, "").trim());
    const config = await getLimitedMenuConfig(env);
    const before = config.limitedItems.length;
    config.limitedItems = config.limitedItems.filter(item => cleanLimitedId(item.id) !== id && String(item.name || "").trim() !== id && String(item.cn || "").trim() !== id);
    config.cleared = config.limitedItems.length === 0;
    await saveLimitedMenuConfig(env, config);
    await sendTelegramMessage(env, chatId, before === config.limitedItems.length ? "找不到要刪除的限定豆子：" + id : "已刪除限定豆子：" + id, buildLimitedListMarkup(config));
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
    config.cleared = config.limitedItems.length === 0;
    await saveLimitedMenuConfig(env, config);
    await sendTelegramMessage(env, chatId, found ? (enable ? "已啟用限定豆子：" : "已停用限定豆子：") + id : "找不到限定豆子：" + id, buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  await sendTelegramMessage(env, chatId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
  return json({ ok: true });
}

handleLimitedMenuAction = async function(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;

  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");

  const parts = String(data || "").split(":");
  const action = parts[0];
  const id = cleanLimitedId(parts.slice(1).join(":"));
  const config = await getLimitedMenuConfig(env);

  if (action === "limited_cmd_menu") {
    await editOrSendV183(env, chatId, messageId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
    return stop(env, cq, "已開啟功能列表");
  }

  if (action === "limited_wizard_add") {
    await startLimitedWizardV183(env, chatId, "add", null);
    return stop(env, cq, "開始新增限定豆子");
  }

  if (action === "limited_wizard_edit") {
    const item = findLimitedItemV183(config, id);
    if (!item) return stop(env, cq, "找不到限定豆子");
    await startLimitedWizardV183(env, chatId, "edit", item);
    return stop(env, cq, "開始編輯限定豆子");
  }

  if (action === "limited_wizard_back") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    draft.step = Math.max(0, Number(draft.step || 0) - 1);
    await saveLimitedDraftV183(env, chatId, draft);
    await sendLimitedWizardPromptV183(env, chatId, draft);
    return stop(env, cq, "已返回上一步");
  }

  if (action === "limited_wizard_skip") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    const step = LIMITED_BEAN_STEPS_V183[Number(draft.step || 0)];
    if (!step || step.required) return stop(env, cq, "此欄必填");
    draft.data[step.key] = "";
    draft.step = Number(draft.step || 0) + 1;
    await saveLimitedDraftV183(env, chatId, draft);
    await sendLimitedWizardPromptV183(env, chatId, draft);
    return stop(env, cq, "已略過");
  }

  if (action === "limited_wizard_cancel") {
    await clearLimitedDraftV183(env, chatId);
    await sendTelegramMessage(env, chatId, "已取消限定豆子編輯。", buildCommandMenuMarkupV183());
    return stop(env, cq, "已取消");
  }

  if (action === "limited_wizard_confirm") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    const saved = await saveLimitedDraftToMenuV183(env, chatId, draft);
    await clearLimitedDraftV183(env, chatId);
    await sendTelegramMessage(env, chatId, "✅ 已確認上傳限定豆子：\n\n" + limitedItemLine(saved) + "\n\n網站 Landing page 及豆子選項會自動更新。", buildLimitedListMarkup(await getLimitedMenuConfig(env)));
    return stop(env, cq, "已上傳");
  }

  if (action === "limited_list") {
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, "已刷新限定豆子列表");
  }

  if (action === "limited_help") {
    await editOrSendV183(env, chatId, messageId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
    return stop(env, cq, "已開啟功能列表");
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
    config.cleared = config.limitedItems.length === 0;
    await saveLimitedMenuConfig(env, config);
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, found ? "已切換限定豆子狀態" : "找不到豆子");
  }

  if (action === "limited_delete") {
    const item = config.limitedItems.find(x => cleanLimitedId(x.id) === id);
    if (!item) return stop(env, cq, "找不到豆子");
    await editOrSendV183(env, chatId, messageId, "確定刪除限定豆子？\n\n" + limitedItemLine(item), {
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
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, "已刪除限定豆子");
  }

  return stop(env, cq, "未知限定操作");
}

async function startLimitedWizardV183(env, chatId, mode, item) {
  const draft = {
    mode,
    targetId: item ? cleanLimitedId(item.id) : "",
    step: 0,
    data: item ? {
      name: item.name || item.bean || "",
      cn: item.cn || "",
      flavor: item.flavor || "",
      desc: item.desc || "",
      note: item.note || ""
    } : {},
    createdAt: new Date().toISOString()
  };
  await saveLimitedDraftV183(env, chatId, draft);
  await sendLimitedWizardPromptV183(env, chatId, draft);
  return json({ ok: true });
}

async function handleLimitedWizardTextV183(env, message, text, draft) {
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;
  const value = String(text || "").trim();

  if (value === "取消" || value.toLowerCase() === "cancel") {
    await clearLimitedDraftV183(env, chatId);
    await sendTelegramMessage(env, chatId, "已取消限定豆子編輯。", buildCommandMenuMarkupV183());
    return json({ ok: true });
  }

  const step = LIMITED_BEAN_STEPS_V183[Number(draft.step || 0)];
  if (!step) {
    await sendLimitedWizardConfirmV183(env, chatId, draft);
    return json({ ok: true });
  }

  if (step.required && !value) {
    await sendTelegramMessage(env, chatId, "這一欄必填。\n\n" + buildLimitedStepTextV183(draft), buildLimitedStepMarkupV183(draft));
    return json({ ok: true });
  }

  draft.data = draft.data || {};
  draft.data[step.key] = value;
  draft.step = Number(draft.step || 0) + 1;
  await saveLimitedDraftV183(env, chatId, draft);
  await sendLimitedWizardPromptV183(env, chatId, draft);
  return json({ ok: true });
}

async function sendLimitedWizardPromptV183(env, chatId, draft) {
  if (Number(draft.step || 0) >= LIMITED_BEAN_STEPS_V183.length) {
    await sendLimitedWizardConfirmV183(env, chatId, draft);
    return;
  }
  await sendTelegramMessage(env, chatId, buildLimitedStepTextV183(draft), buildLimitedStepMarkupV183(draft));
}

function buildLimitedStepTextV183(draft) {
  const stepNo = Number(draft.step || 0);
  const step = LIMITED_BEAN_STEPS_V183[stepNo];
  const modeText = draft.mode === "edit" ? "編輯限定豆子" : "新增限定豆子";
  const lines = [];
  lines.push("✨ " + modeText);
  lines.push("");
  lines.push("步驟 " + (stepNo + 1) + " / " + LIMITED_BEAN_STEPS_V183.length);
  lines.push(step.title);
  lines.push("");
  lines.push(step.hint);
  lines.push("");
  lines.push("目前資料：");
  lines.push(buildLimitedDraftSummaryV183(draft, false));
  return lines.join("\n");
}

function buildLimitedStepMarkupV183(draft) {
  const stepNo = Number(draft.step || 0);
  const step = LIMITED_BEAN_STEPS_V183[stepNo];
  const rows = [];
  const firstRow = [];
  if (stepNo > 0) firstRow.push({ text: "⬅️ 上一步", callback_data: "limited_wizard_back:x" });
  if (step && !step.required) firstRow.push({ text: "略過", callback_data: "limited_wizard_skip:x" });
  if (firstRow.length) rows.push(firstRow);
  rows.push([{ text: "取消", callback_data: "limited_wizard_cancel:x" }]);
  return { inline_keyboard: rows };
}

async function sendLimitedWizardConfirmV183(env, chatId, draft) {
  await sendTelegramMessage(env, chatId, buildLimitedConfirmTextV183(draft), {
    inline_keyboard: [
      [{ text: "✅ 確認上傳", callback_data: "limited_wizard_confirm:x" }],
      [{ text: "⬅️ 上一步", callback_data: "limited_wizard_back:x" }],
      [{ text: "取消", callback_data: "limited_wizard_cancel:x" }]
    ]
  });
}

function buildLimitedConfirmTextV183(draft) {
  return [
    "請確認限定豆子資料：",
    "",
    buildLimitedDraftSummaryV183(draft, true),
    "",
    "價格規則：客人選擇此限定豆子時，自動 +MOP 5。",
    "",
    "確認無誤後，按「確認上傳」。"
  ].join("\n");
}

function buildLimitedDraftSummaryV183(draft, full) {
  const d = (draft && draft.data) || {};
  return [
    "名稱：" + (d.name || "-"),
    "中文：" + (d.cn || "-"),
    "風味：" + (d.flavor || "-"),
    "描述：" + (d.desc || "-"),
    "備註：" + (d.note || "-")
  ].join("\n");
}

async function saveLimitedDraftToMenuV183(env, chatId, draft) {
  const data = (draft && draft.data) || {};
  const name = String(data.name || "").trim();
  const item = {
    id: draft.mode === "edit" && draft.targetId ? cleanLimitedId(draft.targetId) : slugLimitedId(name),
    type: "bean",
    active: true,
    name,
    cn: String(data.cn || name).trim(),
    bean: name,
    flavor: String(data.flavor || "").trim(),
    desc: String(data.desc || "").trim(),
    note: String(data.note || "").trim(),
    surcharge: 5,
    limitedSurcharge: 5,
    updatedAt: new Date().toISOString()
  };

  const config = await getLimitedMenuConfig(env);
  const targetId = cleanLimitedId(draft.targetId || item.id);
  let updated = false;
  config.limitedItems = (Array.isArray(config.limitedItems) ? config.limitedItems : []).map(old => {
    if ((draft.mode === "edit" && cleanLimitedId(old.id) === targetId) || cleanLimitedId(old.id) === cleanLimitedId(item.id)) {
      updated = true;
      return { ...old, ...item, id: old.id || item.id };
    }
    return old;
  });
  if (!updated) config.limitedItems.unshift(item);
  config.cleared = false;
  config.updatedAt = new Date().toISOString();
  config.updatedBy = "telegram-wizard";
  await saveLimitedMenuConfig(env, config);
  return item;
}

function buildCommandMenuTextV183() {
  return [
    "Sky31 Bot 功能列表",
    "",
    "請點擊下面按鈕使用功能：",
    "",
    "✨ 限定豆子管理",
    "新增、編輯、停用、刪除限定豆子。",
    "",
    "👤 會員查詢",
    "查看會員、訂單與累積資料。",
    "",
    "提示：限定豆子只會出現在 Landing page 及飲品內的豆子選項；客人選擇後自動 +MOP 5。"
  ].join("\n");
}

function buildCommandMenuMarkupV183() {
  return {
    inline_keyboard: [
      [{ text: "➕ 新增限定豆子", callback_data: "limited_wizard_add:x" }],
      [{ text: "✨ 限定豆子列表 / 編輯", callback_data: "limited_list:all" }],
      [{ text: "👤 查詢會員", callback_data: "member_list:active:0" }],
      [{ text: "🧹 合併重複會員", callback_data: "member_merge_duplicates:x" }],
      [{ text: "🛠 系統維護", callback_data: "maint_status:x" }]
    ]
  };
}

buildLimitedListText = function(config) {
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  const lines = [];
  lines.push("✨ Sky31 限定豆子列表");
  lines.push("");
  lines.push("目前豆子：" + items.length);
  lines.push("更新時間：" + (config && config.updatedAt ? formatDateTime(config.updatedAt) : "-"));
  lines.push("");
  if (!items.length) {
    lines.push("目前沒有上架限定豆子。");
    lines.push("下一支驚喜豆單正在準備中，敬請期待。");
  } else {
    items.forEach(item => lines.push(limitedItemLine(item)));
  }
  lines.push("");
  lines.push("選擇下方按鈕新增、編輯或管理。");
  return lines.join("\n").trim();
}

buildLimitedListMarkup = function(config) {
  const rows = [];
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];

  rows.push([{ text: "➕ 新增限定豆子", callback_data: "limited_wizard_add:x" }]);

  items.slice(0, 10).forEach(item => {
    const id = cleanLimitedId(item.id);
    rows.push([{ text: "✏️ 編輯 " + (item.name || id), callback_data: "limited_wizard_edit:" + id }]);
    rows.push([
      { text: item.active === false ? "啟用" : "停用", callback_data: "limited_toggle:" + id },
      { text: "刪除", callback_data: "limited_delete:" + id }
    ]);
  });

  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
}

limitedItemLine = function(item) {
  const status = item.active === false ? "停用" : "啟用";
  const surcharge = Number(item.surcharge || item.limitedSurcharge || 5) || 5;
  return [
    "• [" + status + "] " + (item.bean || item.name || "-"),
    "  編號：" + cleanLimitedId(item.id) + "｜選用 +MOP " + surcharge,
    "  中文：" + (item.cn || "-"),
    "  風味：" + (item.flavor || "-"),
    item.desc ? "  描述：" + item.desc : "",
    item.note ? "  備註：" + item.note : ""
  ].filter(Boolean).join("\n");
}

function findLimitedItemV183(config, id) {
  id = cleanLimitedId(id);
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  return items.find(item =>
    cleanLimitedId(item.id) === id ||
    cleanLimitedId(item.name) === id ||
    cleanLimitedId(item.bean) === id ||
    cleanLimitedId(item.cn) === id
  );
}

async function editOrSendV183(env, chatId, messageId, text, markup) {
  if (messageId) {
    const res = await editTelegramMessage(env, chatId, messageId, text, markup);
    if (res && res.ok === false) await sendTelegramMessage(env, chatId, text, markup);
  } else {
    await sendTelegramMessage(env, chatId, text, markup);
  }
}


/* V184: simplified commands and single currently displayed Limited Bean.
   All beans are saved in history/list, but website only displays one current bean. */

function firstActiveLimitedBeanV184(config) {
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  return items.find(item => item.active !== false) || null;
}

function currentLimitedBeanV184(config) {
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  const currentId = cleanLimitedId((config && (config.currentLimitedBeanId || config.currentBeanId)) || "");
  if (currentId) {
    const current = items.find(item => cleanLimitedId(item.id) === currentId && item.active !== false);
    if (current) return current;
  }
  return firstActiveLimitedBeanV184(config);
}

async function normalizeLimitedCurrentV184(env, config) {
  config = config || { limitedItems: [] };
  config.limitedItems = Array.isArray(config.limitedItems) ? config.limitedItems : [];
  const current = currentLimitedBeanV184(config);
  config.currentLimitedBeanId = current ? cleanLimitedId(current.id) : "";
  config.cleared = config.limitedItems.length === 0;
  config.updatedAt = new Date().toISOString();
  await saveLimitedMenuConfig(env, config);
  return config;
}

isBotCommandListV183 = function(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "/start" ||
    t === "/help" ||
    t === "help" ||
    t === "指令" ||
    t === "功能" ||
    t === "功能列表" ||
    t === "菜單" ||
    t === "菜单" ||
    t === "bot" ||
    t === "管理"
  );
}

isLimitedMenuCommand = function(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    isBotCommandListV183(t) ||
    t === "/limited" ||
    t === "/limited_beans" ||
    t === "限定" ||
    t === "限定列表" ||
    t === "限定豆子" ||
    t === "限定豆子列表" ||
    t === "新增豆子" ||
    t === "新增限定豆子" ||
    t === "新增限定" ||
    t === "編輯豆子" ||
    t === "编辑豆子" ||
    t === "編輯限定豆子" ||
    t === "编辑限定豆子" ||
    t.startsWith("編輯限定豆子 ") ||
    t.startsWith("编辑限定豆子 ") ||
    t.startsWith("編輯豆子 ") ||
    t.startsWith("编辑豆子 ") ||
    t.startsWith("刪除限定") ||
    t.startsWith("删除限定") ||
    t.startsWith("停用限定") ||
    t.startsWith("啟用限定") ||
    t.startsWith("启用限定") ||
    t.startsWith("顯示限定") ||
    t.startsWith("显示限定") ||
    t.startsWith("設為顯示") ||
    t.startsWith("设为显示") ||
    t.startsWith("清空限定")
  );
}

handleTelegramTextCommand = async function(env, message) {
  const text = String(message.text || "").trim();
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;

  const activeDraft = await getLimitedDraftV183(env, chatId);
  if (activeDraft && !isBotCommandListV183(text) && !isMemberQueryCommand(text) && !isHardLimitedCommandV183(text)) {
    return handleLimitedWizardTextV183(env, message, text, activeDraft);
  }

  if (isBotCommandListV183(text)) {
    await sendTelegramMessage(env, chatId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
    return json({ ok: true });
  }

  if (isLimitedMenuCommand(text)) {
    return handleLimitedMenuTextCommand(env, message, text);
  }

  if (!isMemberQueryCommand(text)) {
    return json({ ok: true });
  }

  const members = await listTelegramMembers(env);
  await sendTelegramMessage(env, chatId, buildMemberListText(members), buildMemberListMarkup(members));
  return json({ ok: true });
}

isHardLimitedCommandV183 = function(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "取消" ||
    t === "cancel" ||
    t === "新增豆子" ||
    t === "新增限定豆子" ||
    t === "新增限定" ||
    t === "限定豆子列表" ||
    t === "/limited_beans" ||
    t.startsWith("編輯限定豆子 ") ||
    t.startsWith("编辑限定豆子 ") ||
    t.startsWith("編輯豆子 ") ||
    t.startsWith("编辑豆子 ") ||
    t.startsWith("顯示限定") ||
    t.startsWith("显示限定") ||
    t.startsWith("設為顯示") ||
    t.startsWith("设为显示")
  );
}

handleLimitedMenuTextCommand = async function(env, message, text) {
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;

  if (!isAuthorizedTelegramChat(env, chatId)) {
    await sendTelegramMessage(env, chatId, "沒有權限修改 Sky31 限定豆子。", null);
    return json({ ok: true });
  }

  const t = String(text || "").trim();
  const lower = t.toLowerCase();

  if (lower === "/limited" || lower === "/limited_beans" || t === "限定" || t === "限定列表" || t === "限定豆子" || t === "限定豆子列表") {
    let config = await getLimitedMenuConfig(env);
    config = await normalizeLimitedCurrentV184(env, config);
    await sendTelegramMessage(env, chatId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (/^(新增豆子|新增限定豆子|新增限定)$/i.test(t)) {
    return startLimitedWizardV183(env, chatId, "add", null);
  }

  const editMatch = t.match(/^(編輯豆子|编辑豆子|編輯限定豆子|编辑限定豆子|編輯限定|编辑限定)\s+(.+)$/i);
  if (editMatch) {
    let config = await getLimitedMenuConfig(env);
    config = await normalizeLimitedCurrentV184(env, config);
    const item = findLimitedItemV183(config, editMatch[2] || "");
    if (!item) {
      await sendTelegramMessage(env, chatId, "找不到限定豆子：" + (editMatch[2] || "") + "\n請先打開「限定豆子列表」選擇要編輯的豆子。", buildLimitedListMarkup(config));
      return json({ ok: true });
    }
    return startLimitedWizardV183(env, chatId, "edit", item);
  }

  if (/^(編輯豆子|编辑豆子|編輯限定豆子|编辑限定豆子|編輯限定|编辑限定)$/i.test(t)) {
    let config = await getLimitedMenuConfig(env);
    config = await normalizeLimitedCurrentV184(env, config);
    await sendTelegramMessage(env, chatId, "請選擇要編輯的限定豆子：", buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("顯示限定") || t.startsWith("显示限定") || t.startsWith("設為顯示") || t.startsWith("设为显示")) {
    const id = cleanLimitedId(t.replace(/^顯示限定|^显示限定|^設為顯示|^设为显示/, "").trim());
    let config = await getLimitedMenuConfig(env);
    let found = false;
    config.limitedItems = (Array.isArray(config.limitedItems) ? config.limitedItems : []).map(item => {
      if (cleanLimitedId(item.id) === id || String(item.name || "").trim() === id || String(item.cn || "").trim() === id) {
        item.active = true;
        config.currentLimitedBeanId = cleanLimitedId(item.id);
        found = true;
      }
      return item;
    });
    config = await normalizeLimitedCurrentV184(env, config);
    await sendTelegramMessage(env, chatId, found ? "已設定目前顯示限定豆子：" + id : "找不到限定豆子：" + id, buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("清空限定")) {
    await clearLimitedDraftV183(env, chatId);
    const config = await saveLimitedMenuConfig(env, { limitedItems: [], currentLimitedBeanId: "", cleared: true, updatedAt: new Date().toISOString(), updatedBy: "telegram" });
    await sendTelegramMessage(env, chatId, "已清空所有限定豆子。\n網站會顯示：下一支驚喜豆單正在準備中，敬請期待。", buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("刪除限定") || t.startsWith("删除限定")) {
    const id = cleanLimitedId(t.replace(/^刪除限定|^删除限定/, "").trim());
    let config = await getLimitedMenuConfig(env);
    const before = config.limitedItems.length;
    config.limitedItems = config.limitedItems.filter(item => cleanLimitedId(item.id) !== id && String(item.name || "").trim() !== id && String(item.cn || "").trim() !== id);
    if (config.currentLimitedBeanId === id) config.currentLimitedBeanId = "";
    config = await normalizeLimitedCurrentV184(env, config);
    await sendTelegramMessage(env, chatId, before === config.limitedItems.length ? "找不到要刪除的限定豆子：" + id : "已刪除限定豆子：" + id, buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  if (t.startsWith("停用限定") || t.startsWith("啟用限定") || t.startsWith("启用限定")) {
    const enable = t.startsWith("啟用限定") || t.startsWith("启用限定");
    const id = cleanLimitedId(t.replace(/^停用限定|^啟用限定|^启用限定/, "").trim());
    let config = await getLimitedMenuConfig(env);
    let found = false;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id || String(item.name || "").trim() === id || String(item.cn || "").trim() === id) {
        item.active = enable;
        item.updatedAt = new Date().toISOString();
        if (enable) config.currentLimitedBeanId = cleanLimitedId(item.id);
        if (!enable && config.currentLimitedBeanId === cleanLimitedId(item.id)) config.currentLimitedBeanId = "";
        found = true;
      }
    });
    config = await normalizeLimitedCurrentV184(env, config);
    await sendTelegramMessage(env, chatId, found ? (enable ? "已啟用並設為目前顯示：" : "已停用限定豆子：") + id : "找不到限定豆子：" + id, buildLimitedListMarkup(config));
    return json({ ok: true });
  }

  await sendTelegramMessage(env, chatId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
  return json({ ok: true });
}

handleLimitedMenuAction = async function(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;

  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");

  const parts = String(data || "").split(":");
  const action = parts[0];
  const id = cleanLimitedId(parts.slice(1).join(":"));
  let config = await getLimitedMenuConfig(env);
  config = await normalizeLimitedCurrentV184(env, config);

  if (action === "limited_cmd_menu") {
    await editOrSendV183(env, chatId, messageId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
    return stop(env, cq, "已開啟功能列表");
  }

  if (action === "limited_wizard_add") {
    await startLimitedWizardV183(env, chatId, "add", null);
    return stop(env, cq, "開始新增限定豆子");
  }

  if (action === "limited_wizard_edit") {
    const item = findLimitedItemV183(config, id);
    if (!item) return stop(env, cq, "找不到限定豆子");
    await startLimitedWizardV183(env, chatId, "edit", item);
    return stop(env, cq, "開始編輯限定豆子");
  }

  if (action === "limited_set_current") {
    let found = false;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id) {
        item.active = true;
        config.currentLimitedBeanId = cleanLimitedId(item.id);
        item.updatedAt = new Date().toISOString();
        found = true;
      }
    });
    config = await normalizeLimitedCurrentV184(env, config);
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, found ? "已設為目前顯示" : "找不到豆子");
  }

  if (action === "limited_wizard_back") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    draft.step = Math.max(0, Number(draft.step || 0) - 1);
    await saveLimitedDraftV183(env, chatId, draft);
    await sendLimitedWizardPromptV183(env, chatId, draft);
    return stop(env, cq, "已返回上一步");
  }

  if (action === "limited_wizard_skip") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    const step = LIMITED_BEAN_STEPS_V183[Number(draft.step || 0)];
    if (!step || step.required) return stop(env, cq, "此欄必填");
    draft.data[step.key] = "";
    draft.step = Number(draft.step || 0) + 1;
    await saveLimitedDraftV183(env, chatId, draft);
    await sendLimitedWizardPromptV183(env, chatId, draft);
    return stop(env, cq, "已略過");
  }

  if (action === "limited_wizard_cancel") {
    await clearLimitedDraftV183(env, chatId);
    await sendTelegramMessage(env, chatId, "已取消限定豆子編輯。", buildCommandMenuMarkupV183());
    return stop(env, cq, "已取消");
  }

  if (action === "limited_wizard_confirm") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    const saved = await saveLimitedDraftToMenuV183(env, chatId, draft);
    await clearLimitedDraftV183(env, chatId);
    config = await normalizeLimitedCurrentV184(env, await getLimitedMenuConfig(env));
    await sendTelegramMessage(env, chatId, "✅ 已確認上傳限定豆子：\n\n" + limitedItemLine(saved) + "\n\n已自動設為目前顯示；網站只會顯示這一款限定豆子。", buildLimitedListMarkup(config));
    return stop(env, cq, "已上傳");
  }

  if (action === "limited_list") {
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, "已刷新限定豆子列表");
  }

  if (action === "limited_toggle") {
    let found = false;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id) {
        item.active = item.active === false ? true : false;
        item.updatedAt = new Date().toISOString();
        if (item.active) config.currentLimitedBeanId = cleanLimitedId(item.id);
        if (!item.active && config.currentLimitedBeanId === cleanLimitedId(item.id)) config.currentLimitedBeanId = "";
        found = true;
      }
    });
    config = await normalizeLimitedCurrentV184(env, config);
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, found ? "已切換限定豆子狀態" : "找不到豆子");
  }

  if (action === "limited_delete") {
    const item = config.limitedItems.find(x => cleanLimitedId(x.id) === id);
    if (!item) return stop(env, cq, "找不到豆子");
    await editOrSendV183(env, chatId, messageId, "確定刪除限定豆子？\n\n" + limitedItemLine(item), {
      inline_keyboard: [
        [{ text: "✅ 確認刪除", callback_data: "limited_delete_yes:" + id }],
        [{ text: "取消", callback_data: "limited_list:all" }]
      ]
    });
    return stop(env, cq, "請確認刪除");
  }

  if (action === "limited_delete_yes") {
    config.limitedItems = config.limitedItems.filter(item => cleanLimitedId(item.id) !== id);
    if (config.currentLimitedBeanId === id) config.currentLimitedBeanId = "";
    config = await normalizeLimitedCurrentV184(env, config);
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, "已刪除限定豆子");
  }

  return stop(env, cq, "未知限定操作");
}

saveLimitedDraftToMenuV183 = async function(env, chatId, draft) {
  const data = (draft && draft.data) || {};
  const name = String(data.name || "").trim();
  const item = {
    id: draft.mode === "edit" && draft.targetId ? cleanLimitedId(draft.targetId) : slugLimitedId(name),
    type: "bean",
    active: true,
    name,
    cn: String(data.cn || name).trim(),
    bean: name,
    flavor: String(data.flavor || "").trim(),
    desc: String(data.desc || "").trim(),
    note: String(data.note || "").trim(),
    surcharge: 5,
    limitedSurcharge: 5,
    updatedAt: new Date().toISOString()
  };

  const config = await getLimitedMenuConfig(env);
  const targetId = cleanLimitedId(draft.targetId || item.id);
  let updated = false;
  config.limitedItems = (Array.isArray(config.limitedItems) ? config.limitedItems : []).map(old => {
    if ((draft.mode === "edit" && cleanLimitedId(old.id) === targetId) || cleanLimitedId(old.id) === cleanLimitedId(item.id)) {
      updated = true;
      return { ...old, ...item, id: old.id || item.id, active: true };
    }
    return old;
  });
  if (!updated) config.limitedItems.unshift(item);

  // Newly added or edited bean becomes the only currently displayed Limited Bean.
  config.currentLimitedBeanId = cleanLimitedId(item.id);
  config.cleared = false;
  config.updatedAt = new Date().toISOString();
  config.updatedBy = "telegram-wizard";
  await saveLimitedMenuConfig(env, config);
  return item;
}

buildCommandMenuTextV183 = function() {
  return [
    "Sky31 Bot 功能",
    "",
    "請選擇要使用的功能：",
    "",
    "✨ 限定豆子",
    "新增、查看、編輯、刪除；網站每次只顯示一款目前上架豆子。",
    "",
    "👤 會員查詢"
  ].join("\n");
}

buildCommandMenuMarkupV183 = function() {
  return {
    inline_keyboard: [
      [{ text: "✨ 限定豆子管理", callback_data: "limited_list:all" }],
      [{ text: "➕ 新增限定豆子", callback_data: "limited_wizard_add:x" }],
      [{ text: "👤 查詢會員", callback_data: "member_list:active:0" }]
    ]
  };
}

buildLimitedListText = function(config) {
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  const current = currentLimitedBeanV184(config);
  const currentId = current ? cleanLimitedId(current.id) : "";
  const lines = [];
  lines.push("✨ Sky31 限定豆子");
  lines.push("");
  lines.push("保存豆子：" + items.length);
  lines.push("目前顯示：" + (current ? (current.bean || current.name || "-") : "暫無"));
  lines.push("");
  if (!items.length) {
    lines.push("目前沒有保存限定豆子。");
    lines.push("下一支驚喜豆單正在準備中，敬請期待。");
  } else {
    items.forEach(item => lines.push(limitedItemLineWithCurrentV184(item, currentId)));
  }
  lines.push("");
  lines.push("網站 Landing page 和點餐豆子選項只會顯示「目前顯示」那一款。");
  return lines.join("\n").trim();
}

function limitedItemLineWithCurrentV184(item, currentId) {
  const status = item.active === false ? "停用" : "啟用";
  const current = cleanLimitedId(item.id) === currentId ? "｜目前顯示" : "";
  const surcharge = Number(item.surcharge || item.limitedSurcharge || 5) || 5;
  return [
    "• [" + status + "] " + (item.bean || item.name || "-") + current,
    "  編號：" + cleanLimitedId(item.id) + "｜選用 +MOP " + surcharge,
    "  風味：" + (item.flavor || "-"),
    item.desc ? "  描述：" + item.desc : "",
    item.note ? "  備註：" + item.note : ""
  ].filter(Boolean).join("\n");
}

buildLimitedListMarkup = function(config) {
  const rows = [];
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  const current = currentLimitedBeanV184(config);
  const currentId = current ? cleanLimitedId(current.id) : "";

  rows.push([{ text: "➕ 新增限定豆子", callback_data: "limited_wizard_add:x" }]);

  items.slice(0, 10).forEach(item => {
    const id = cleanLimitedId(item.id);
    const title = (id === currentId ? "✅ " : "") + (item.name || id);
    rows.push([{ text: title, callback_data: "limited_wizard_edit:" + id }]);
    const row = [];
    if (id !== currentId && item.active !== false) row.push({ text: "設為顯示", callback_data: "limited_set_current:" + id });
    row.push({ text: "編輯", callback_data: "limited_wizard_edit:" + id });
    row.push({ text: "刪除", callback_data: "limited_delete:" + id });
    rows.push(row);
  });

  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
}


/* V185: type "list" to show full clickable function list. */
isBotCommandListV183 = function(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "list" ||
    t === "/list" ||
    t === "/start" ||
    t === "/help" ||
    t === "help" ||
    t === "指令" ||
    t === "功能" ||
    t === "功能列表" ||
    t === "菜單" ||
    t === "菜单" ||
    t === "bot" ||
    t === "管理"
  );
}

buildCommandMenuTextV183 = function() {
  return [
    "Sky31 Bot 功能列表",
    "",
    "輸入 list 可以再次打開這個列表。",
    "",
    "✨ 限定豆子",
    "新增、查看、編輯、刪除，並設定目前顯示中的限定豆子。",
    "",
    "👤 會員",
    "查詢會員列表與會員資料。",
    "",
    "📦 訂單",
    "訂單訊息內會提供完成訂單 / 已領取等按鈕。",
    "",
    "目前網站規則：",
    "Landing page 和點餐頁面只會顯示一款目前上架的限定豆子；客人選擇限定豆子自動 +MOP 5。"
  ].join("\n");
}

buildCommandMenuMarkupV183 = function() {
  return {
    inline_keyboard: [
      [{ text: "✨ 限定豆子管理", callback_data: "limited_list:all" }],
      [{ text: "➕ 新增限定豆子", callback_data: "limited_wizard_add:x" }],
      [{ text: "👤 查詢會員", callback_data: "member_list:active:0" }],
      [{ text: "🔄 重新顯示功能列表", callback_data: "limited_cmd_menu:x" }]
    ]
  };
}


/* V187: Limited Bean display fix + detail delete/restore + back buttons.
   Telegram can save multiple beans, but website only receives one current visible bean. */

function visibleLimitedItemsV187(config) {
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  return items.filter(item => item && item.deleted !== true && item.active !== false);
}

currentLimitedBeanV184 = function(config) {
  const active = visibleLimitedItemsV187(config);
  if (!active.length) return null;
  const currentId = cleanLimitedId((config && (config.currentLimitedBeanId || config.currentBeanId)) || "");
  if (currentId) {
    const current = active.find(item => cleanLimitedId(item.id) === currentId);
    if (current) return current;
  }
  return active[0];
};

normalizeLimitedCurrentV184 = async function(env, config) {
  config = config || { limitedItems: [] };
  config.limitedItems = Array.isArray(config.limitedItems) ? config.limitedItems : [];
  const current = currentLimitedBeanV184(config);
  config.currentLimitedBeanId = current ? cleanLimitedId(current.id) : "";
  config.cleared = config.limitedItems.length === 0;
  config.updatedAt = new Date().toISOString();
  await saveLimitedMenuConfig(env, config);
  return config;
};

saveLimitedDraftToMenuV183 = async function(env, chatId, draft) {
  const data = (draft && draft.data) || {};
  const name = String(data.name || "").trim();
  const item = {
    id: draft.mode === "edit" && draft.targetId ? cleanLimitedId(draft.targetId) : slugLimitedId(name),
    type: "bean",
    active: true,
    deleted: false,
    name,
    cn: String(data.cn || name).trim(),
    bean: name,
    flavor: String(data.flavor || "").trim(),
    desc: String(data.desc || "").trim(),
    note: String(data.note || "").trim(),
    surcharge: 5,
    limitedSurcharge: 5,
    updatedAt: new Date().toISOString()
  };

  const config = await getLimitedMenuConfig(env);
  const targetId = cleanLimitedId(draft.targetId || item.id);
  let updated = false;
  config.limitedItems = (Array.isArray(config.limitedItems) ? config.limitedItems : []).map(old => {
    if ((draft.mode === "edit" && cleanLimitedId(old.id) === targetId) || cleanLimitedId(old.id) === cleanLimitedId(item.id)) {
      updated = true;
      return { ...old, ...item, id: old.id || item.id, active: true, deleted: false };
    }
    return old;
  });
  if (!updated) config.limitedItems.unshift(item);

  config.currentLimitedBeanId = cleanLimitedId(item.id);
  config.cleared = false;
  config.updatedAt = new Date().toISOString();
  config.updatedBy = "telegram-wizard";
  await saveLimitedMenuConfig(env, config);
  return item;
};

function limitedBeanDetailTextV187(item, isCurrent) {
  if (!item) return "找不到限定豆子。";
  const deleted = item.deleted === true;
  const status = deleted ? "已刪除" : (item.active === false ? "已停用" : "上架中");
  return [
    "✨ 限定豆子資料",
    "",
    "名稱：" + (item.bean || item.name || "-"),
    "中文：" + (item.cn || "-"),
    "風味：" + (item.flavor || "-"),
    item.desc ? "描述：" + item.desc : "",
    item.note ? "備註：" + item.note : "",
    "編號：" + cleanLimitedId(item.id),
    "狀態：" + status + (isCurrent ? "｜目前顯示" : ""),
    "價格：客人選擇時自動 +MOP 5"
  ].filter(Boolean).join("\n");
}

function limitedBeanDetailMarkupV187(item, isCurrent) {
  const id = cleanLimitedId(item && item.id);
  const rows = [];
  if (!item) {
    rows.push([{ text: "返回豆子列表", callback_data: "limited_list:all" }]);
    rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
    return { inline_keyboard: rows };
  }

  if (item.deleted === true) {
    rows.push([{ text: "↩️ 恢復豆子", callback_data: "limited_restore:" + id }]);
  } else {
    if (!isCurrent && item.active !== false) rows.push([{ text: "✅ 設為目前顯示", callback_data: "limited_set_current:" + id }]);
    rows.push([{ text: "✏️ 編輯豆子", callback_data: "limited_wizard_edit:" + id }]);
    rows.push([{ text: "🗑️ 刪除豆子", callback_data: "limited_delete:" + id }]);
  }

  rows.push([{ text: "返回豆子列表", callback_data: "limited_list:all" }]);
  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
}

buildLimitedListText = function(config) {
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  const activeSaved = items.filter(item => item && item.deleted !== true);
  const deletedCount = items.filter(item => item && item.deleted === true).length;
  const current = currentLimitedBeanV184(config);
  const lines = [];
  lines.push("✨ Sky31 限定豆子");
  lines.push("");
  lines.push("保存豆子：" + activeSaved.length);
  if (deletedCount) lines.push("已刪除可恢復：" + deletedCount);
  lines.push("目前顯示：" + (current ? (current.bean || current.name || "-") : "暫無"));
  lines.push("");
  if (!items.length) {
    lines.push("目前沒有保存限定豆子。");
    lines.push("下一支驚喜豆單正在準備中，敬請期待。");
  } else {
    items.forEach(item => lines.push(limitedItemLineWithCurrentV184(item, current ? cleanLimitedId(current.id) : "")));
  }
  lines.push("");
  lines.push("點擊豆子名稱進入後，才會看到刪除 / 恢復選項。");
  lines.push("網站只會顯示「目前顯示」那一款限定豆子。");
  return lines.join("\n").trim();
};

limitedItemLineWithCurrentV184 = function(item, currentId) {
  const status = item.deleted === true ? "已刪除" : (item.active === false ? "停用" : "啟用");
  const current = cleanLimitedId(item.id) === currentId && item.deleted !== true ? "｜目前顯示" : "";
  const surcharge = Number(item.surcharge || item.limitedSurcharge || 5) || 5;
  return [
    "• [" + status + "] " + (item.bean || item.name || "-") + current,
    "  編號：" + cleanLimitedId(item.id) + "｜選用 +MOP " + surcharge,
    "  風味：" + (item.flavor || "-")
  ].filter(Boolean).join("\n");
};

buildLimitedListMarkup = function(config) {
  const rows = [];
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  const current = currentLimitedBeanV184(config);
  const currentId = current ? cleanLimitedId(current.id) : "";

  rows.push([{ text: "➕ 新增限定豆子", callback_data: "limited_wizard_add:x" }]);

  items.slice(0, 12).forEach(item => {
    const id = cleanLimitedId(item.id);
    const prefix = item.deleted === true ? "🗑️ " : (id === currentId ? "✅ " : "☕ ");
    rows.push([{ text: (prefix + (item.name || item.bean || id)).slice(0, 60), callback_data: "limited_detail:" + id }]);
  });

  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
};

handleLimitedMenuAction = async function(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;

  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");

  const parts = String(data || "").split(":");
  const action = parts[0];
  const id = cleanLimitedId(parts.slice(1).join(":"));
  let config = await getLimitedMenuConfig(env);
  config = await normalizeLimitedCurrentV184(env, config);

  if (action === "limited_cmd_menu") {
    await editOrSendV183(env, chatId, messageId, buildCommandMenuTextV183(), buildCommandMenuMarkupV183());
    return stop(env, cq, "已返回功能列表");
  }

  if (action === "limited_list") {
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, "已返回豆子列表");
  }

  if (action === "limited_detail") {
    const item = findLimitedItemV183(config, id);
    if (!item) return stop(env, cq, "找不到豆子");
    const current = currentLimitedBeanV184(config);
    const isCurrent = current && cleanLimitedId(current.id) === cleanLimitedId(item.id) && item.deleted !== true;
    await editOrSendV183(env, chatId, messageId, limitedBeanDetailTextV187(item, isCurrent), limitedBeanDetailMarkupV187(item, isCurrent));
    return stop(env, cq, "已開啟豆子資料");
  }

  if (action === "limited_wizard_add") {
    await startLimitedWizardV183(env, chatId, "add", null);
    return stop(env, cq, "開始新增限定豆子");
  }

  if (action === "limited_wizard_edit") {
    const item = findLimitedItemV183(config, id);
    if (!item || item.deleted === true) return stop(env, cq, "找不到可編輯豆子");
    await startLimitedWizardV183(env, chatId, "edit", item);
    return stop(env, cq, "開始編輯限定豆子");
  }

  if (action === "limited_set_current") {
    let found = false;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id && item.deleted !== true) {
        item.active = true;
        config.currentLimitedBeanId = cleanLimitedId(item.id);
        item.updatedAt = new Date().toISOString();
        found = true;
      }
    });
    config = await normalizeLimitedCurrentV184(env, config);
    const item = findLimitedItemV183(config, id);
    await editOrSendV183(env, chatId, messageId, limitedBeanDetailTextV187(item, true), limitedBeanDetailMarkupV187(item, true));
    return stop(env, cq, found ? "已設為目前顯示" : "找不到豆子");
  }

  if (action === "limited_restore") {
    let restored = null;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id) {
        item.deleted = false;
        item.active = true;
        item.updatedAt = new Date().toISOString();
        config.currentLimitedBeanId = cleanLimitedId(item.id);
        restored = item;
      }
    });
    config = await normalizeLimitedCurrentV184(env, config);
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, restored ? "已恢復並設為目前顯示" : "找不到豆子");
  }

  if (action === "limited_delete") {
    const item = findLimitedItemV183(config, id);
    if (!item || item.deleted === true) return stop(env, cq, "找不到豆子");
    await editOrSendV183(env, chatId, messageId, "確定刪除此限定豆子？\n\n" + limitedBeanDetailTextV187(item, false), {
      inline_keyboard: [
        [{ text: "✅ 確認刪除", callback_data: "limited_delete_yes:" + id }],
        [{ text: "取消，返回豆子資料", callback_data: "limited_detail:" + id }],
        [{ text: "返回豆子列表", callback_data: "limited_list:all" }]
      ]
    });
    return stop(env, cq, "請確認刪除");
  }

  if (action === "limited_delete_yes") {
    let deleted = null;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id) {
        item.deleted = true;
        item.active = false;
        item.updatedAt = new Date().toISOString();
        deleted = item;
      }
    });
    if (config.currentLimitedBeanId === id) config.currentLimitedBeanId = "";
    config = await normalizeLimitedCurrentV184(env, config);
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, deleted ? "已刪除，可在列表中恢復" : "找不到豆子");
  }

  if (action === "limited_toggle") {
    let found = false;
    config.limitedItems.forEach(item => {
      if (cleanLimitedId(item.id) === id && item.deleted !== true) {
        item.active = item.active === false ? true : false;
        if (item.active) config.currentLimitedBeanId = cleanLimitedId(item.id);
        if (!item.active && config.currentLimitedBeanId === cleanLimitedId(item.id)) config.currentLimitedBeanId = "";
        found = true;
      }
    });
    config = await normalizeLimitedCurrentV184(env, config);
    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, found ? "已切換狀態" : "找不到豆子");
  }

  if (action === "limited_wizard_back") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    draft.step = Math.max(0, Number(draft.step || 0) - 1);
    await saveLimitedDraftV183(env, chatId, draft);
    await sendLimitedWizardPromptV183(env, chatId, draft);
    return stop(env, cq, "已返回上一步");
  }

  if (action === "limited_wizard_skip") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    const step = LIMITED_BEAN_STEPS_V183[Number(draft.step || 0)];
    if (!step || step.required) return stop(env, cq, "此欄必填");
    draft.data[step.key] = "";
    draft.step = Number(draft.step || 0) + 1;
    await saveLimitedDraftV183(env, chatId, draft);
    await sendLimitedWizardPromptV183(env, chatId, draft);
    return stop(env, cq, "已略過");
  }

  if (action === "limited_wizard_cancel") {
    await clearLimitedDraftV183(env, chatId);
    await sendTelegramMessage(env, chatId, "已取消限定豆子編輯。", buildCommandMenuMarkupV183());
    return stop(env, cq, "已取消");
  }

  if (action === "limited_wizard_confirm") {
    const draft = await getLimitedDraftV183(env, chatId);
    if (!draft) return stop(env, cq, "沒有正在編輯的豆子");
    const saved = await saveLimitedDraftToMenuV183(env, chatId, draft);
    await clearLimitedDraftV183(env, chatId);
    config = await normalizeLimitedCurrentV184(env, await getLimitedMenuConfig(env));
    await sendTelegramMessage(env, chatId, "✅ 已上傳限定豆子：\n\n" + limitedBeanDetailTextV187(saved, true) + "\n\n已自動設為目前顯示。", buildLimitedListMarkup(config));
    return stop(env, cq, "已上傳");
  }

  return stop(env, cq, "未知限定操作");
};

buildMemberListMarkup = function(members) {
  const rows = [];
  members.slice(0, 80).forEach(member => {
    const phone = normalizePhone(member.phone);
    const name = member.name || "未命名";
    const deleted = !!member._deleted;
    const label = (deleted ? "🗑️ " : "👤 ") + name + "｜" + phone + (deleted ? "｜已刪除" : "");
    rows.push([{ text: label.slice(0, 60), callback_data: (deleted ? "member_view_deleted:" : "member_view_active:") + phone }]);
  });
  if (members.length > 80) rows.push([{ text: "只顯示前 80 位", callback_data: "member_list:all" }]);
  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
};

buildMemberDetailReplyMarkup = function(member, deleted = false) {
  const phone = normalizePhone(member.phone);
  const rows = [];
  if (deleted) rows.push([{ text: "↩️ 恢復賬號", callback_data: "member_restore:" + phone }]);
  else rows.push([{ text: "🗑️ 刪除賬號", callback_data: "member_delete:" + phone }]);
  rows.push([{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]);
  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
};


/* V191: allow up to two Limited Beans displayed on website. */
function currentLimitedBeanIdsV191(config) {
  config = config || {};
  let ids = [];
  if (Array.isArray(config.currentLimitedBeanIds)) {
    ids = config.currentLimitedBeanIds.map(cleanLimitedId).filter(Boolean);
  } else if (config.currentLimitedBeanId) {
    ids = [cleanLimitedId(config.currentLimitedBeanId)];
  }
  return Array.from(new Set(ids)).slice(0, 2);
}

function visibleLimitedItemsV191(config) {
  const items = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  return items.filter(item => item && item.deleted !== true && item.active !== false);
}

function currentLimitedBeansV191(config) {
  const active = visibleLimitedItemsV191(config);
  if (!active.length) return [];
  const ids = currentLimitedBeanIdsV191(config);
  const selected = [];
  ids.forEach(id => {
    const item = active.find(x => cleanLimitedId(x.id) === id);
    if (item && !selected.find(x => cleanLimitedId(x.id) === cleanLimitedId(item.id))) selected.push(item);
  });
  active.forEach(item => {
    if (selected.length < 2 && !selected.find(x => cleanLimitedId(x.id) === cleanLimitedId(item.id))) selected.push(item);
  });
  return selected.slice(0, 2);
}

currentLimitedBeanV184 = function(config) {
  const beans = currentLimitedBeansV191(config);
  return beans[0] || null;
};

normalizeLimitedCurrentV184 = async function(env, config) {
  config = config || { limitedItems: [] };
  config.limitedItems = Array.isArray(config.limitedItems) ? config.limitedItems : [];
  const beans = currentLimitedBeansV191(config);
  config.currentLimitedBeanIds = beans.map(item => cleanLimitedId(item.id)).slice(0, 2);
  config.currentLimitedBeanId = config.currentLimitedBeanIds[0] || "";
  config.cleared = config.limitedItems.length === 0;
  config.updatedAt = new Date().toISOString();
  await saveLimitedMenuConfig(env, config);
  return config;
};

saveLimitedDraftToMenuV183 = async function(env, chatId, draft) {
  const data = (draft && draft.data) || {};
  const name = String(data.name || "").trim();
  const item = {
    id: draft.mode === "edit" && draft.targetId ? cleanLimitedId(draft.targetId) : slugLimitedId(name),
    type: "bean",
    active: true,
    deleted: false,
    name,
    cn: String(data.cn || name).trim(),
    bean: name,
    flavor: String(data.flavor || "").trim(),
    desc: String(data.desc || "").trim(),
    note: String(data.note || "").trim(),
    surcharge: 5,
    limitedSurcharge: 5,
    updatedAt: new Date().toISOString()
  };

  const config = await getLimitedMenuConfig(env);
  const targetId = cleanLimitedId(draft.targetId || item.id);
  let updated = false;
  config.limitedItems = (Array.isArray(config.limitedItems) ? config.limitedItems : []).map(old => {
    if ((draft.mode === "edit" && cleanLimitedId(old.id) === targetId) || cleanLimitedId(old.id) === cleanLimitedId(item.id)) {
      updated = true;
      return { ...old, ...item, id: old.id || item.id, active: true, deleted: false };
    }
    return old;
  });
  if (!updated) config.limitedItems.unshift(item);

  const id = cleanLimitedId(item.id);
  const oldIds = currentLimitedBeanIdsV191(config).filter(x => x !== id);
  config.currentLimitedBeanIds = [id, ...oldIds].slice(0, 2);
  config.currentLimitedBeanId = config.currentLimitedBeanIds[0] || "";
  config.cleared = false;
  config.updatedAt = new Date().toISOString();
  config.updatedBy = "telegram-wizard";
  await saveLimitedMenuConfig(env, config);
  return item;
};

limitedBeanDetailMarkupV187 = function(item, isCurrent) {
  const id = cleanLimitedId(item && item.id);
  const rows = [];
  if (!item) {
    rows.push([{ text: "返回豆子列表", callback_data: "limited_list:all" }]);
    rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
    return { inline_keyboard: rows };
  }

  if (item.deleted === true) {
    rows.push([{ text: "↩️ 恢復豆子", callback_data: "limited_restore:" + id }]);
    rows.push([{ text: "⚠️ 永久刪除", callback_data: "limited_permanent_delete:" + id }]);
  } else {
    rows.push([{ text: isCurrent ? "從網站顯示移除" : "加入網站顯示", callback_data: "limited_toggle_display:" + id }]);
    rows.push([{ text: "✏️ 編輯豆子", callback_data: "limited_wizard_edit:" + id }]);
    rows.push([{ text: "🗑️ 刪除豆子", callback_data: "limited_delete:" + id }]);
  }

  rows.push([{ text: "返回豆子列表", callback_data: "limited_list:all" }]);
  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
};

buildLimitedListText = function(config) {
  const allItems = Array.isArray(config && config.limitedItems) ? config.limitedItems : [];
  const items = allItems.filter(item => item && item.permanentDeleted !== true);
  const activeSaved = items.filter(item => item && item.deleted !== true);
  const deletedCount = items.filter(item => item && item.deleted === true).length;
  const currentBeans = currentLimitedBeansV191({ ...(config || {}), limitedItems: items });
  const lines = [];
  lines.push("✨ Sky31 限定豆子");
  lines.push("");
  lines.push("保存豆子：" + activeSaved.length);
  if (deletedCount) lines.push("已刪除可恢復：" + deletedCount + "（可永久刪除）");
  lines.push("網站顯示：" + (currentBeans.length ? currentBeans.map(x => x.bean || x.name || "-").join(" / ") : "暫無"));
  lines.push("");
  if (!items.length) {
    lines.push("目前沒有保存限定豆子。");
    lines.push("下一支驚喜豆單正在準備中，敬請期待。");
  } else {
    const ids = currentBeans.map(x => cleanLimitedId(x.id));
    items.forEach(item => lines.push(limitedItemLineWithCurrentV184(item, ids)));
  }
  lines.push("");
  lines.push("提示：普通刪除可恢復；永久刪除後不會再出現在列表。");
  lines.push("網站最多顯示 2 款限定豆子。");
  return lines.join("\n");
};

limitedItemLineWithCurrentV184 = function(item, currentIds) {
  currentIds = Array.isArray(currentIds) ? currentIds : [currentIds].filter(Boolean);
  const status = item.deleted === true ? "已刪除" : (item.active === false ? "停用" : "啟用");
  const current = currentIds.includes(cleanLimitedId(item.id)) && item.deleted !== true ? "｜網站顯示" : "";
  const surcharge = Number(item.surcharge || item.limitedSurcharge || 5) || 5;
  return [
    "• [" + status + "] " + (item.bean || item.name || "-") + current,
    "  編號：" + cleanLimitedId(item.id) + "｜選用 +MOP " + surcharge,
    "  風味：" + (item.flavor || "-")
  ].filter(Boolean).join("\n");
};

buildLimitedListMarkup = function(config) {
  const rows = [];
  const items = (Array.isArray(config && config.limitedItems) ? config.limitedItems : [])
    .filter(item => item && item.permanentDeleted !== true);
  const currentIds = currentLimitedBeansV191({ ...(config || {}), limitedItems: items }).map(item => cleanLimitedId(item.id));

  rows.push([{ text: "➕ 新增限定豆子", callback_data: "limited_wizard_add:x" }]);

  items.slice(0, 12).forEach(item => {
    const id = cleanLimitedId(item.id);
    const prefix = item.deleted === true ? "🗑️ " : (currentIds.includes(id) ? "✅ " : "☕ ");
    const label = (prefix + (item.name || item.bean || id)).slice(0, 48);
    if (item.deleted === true) {
      rows.push([
        { text: label, callback_data: "limited_detail:" + id },
        { text: "永久刪除", callback_data: "limited_permanent_delete:" + id }
      ]);
    } else {
      rows.push([{ text: label, callback_data: "limited_detail:" + id }]);
    }
  });

  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
};

const _oldHandleLimitedMenuActionV191 = handleLimitedMenuAction;
handleLimitedMenuAction = async function(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;
  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");

  const parts = String(data || "").split(":");
  const action = parts[0];
  const id = cleanLimitedId(parts.slice(1).join(":"));

  if (action === "limited_permanent_delete") {
    let config = await getLimitedMenuConfig(env);
    config.limitedItems = Array.isArray(config.limitedItems) ? config.limitedItems : [];
    const item = config.limitedItems.find(x => cleanLimitedId(x.id) === id);
    if (!item) return stop(env, cq, "找不到豆子");

    await editOrSendV183(env, chatId, messageId,
      "⚠️ 確認永久刪除限定豆子？\n\n" +
      "豆子：" + (item.bean || item.name || id) + "\n" +
      "編號：" + id + "\n\n" +
      "永久刪除後將不會再出現在 Telegram 限定豆子列表，亦不能恢復。",
      {
        inline_keyboard: [
          [{ text: "⚠️ 確認永久刪除", callback_data: "limited_permanent_delete_yes:" + id }],
          [{ text: "取消，返回豆子資料", callback_data: "limited_detail:" + id }],
          [{ text: "返回豆子列表", callback_data: "limited_list:all" }]
        ]
      }
    );
    return stop(env, cq, "請確認永久刪除");
  }

  if (action === "limited_permanent_delete_yes") {
    let config = await getLimitedMenuConfig(env);
    config.limitedItems = Array.isArray(config.limitedItems) ? config.limitedItems : [];

    const before = config.limitedItems.length;
    const removed = config.limitedItems.find(item => cleanLimitedId(item.id) === id);
    config.limitedItems = config.limitedItems.filter(item => cleanLimitedId(item.id) !== id);

    const ids = Array.isArray(config.currentLimitedBeanIds)
      ? config.currentLimitedBeanIds.map(cleanLimitedId).filter(x => x && x !== id)
      : [];
    config.currentLimitedBeanIds = ids.slice(0, 2);
    if (cleanLimitedId(config.currentLimitedBeanId) === id) config.currentLimitedBeanId = config.currentLimitedBeanIds[0] || "";
    config.cleared = config.limitedItems.filter(item => item && item.deleted !== true).length === 0;
    config.updatedAt = new Date().toISOString();
    config.updatedBy = "telegram-permanent-delete";

    await saveLimitedMenuConfig(env, config);
    config = await normalizeLimitedCurrentV184(env, await getLimitedMenuConfig(env));

    await editOrSendV183(env, chatId, messageId, buildLimitedListText(config), buildLimitedListMarkup(config));
    return stop(env, cq, before !== config.limitedItems.length ? "已永久刪除：" + ((removed && (removed.bean || removed.name)) || id) : "找不到豆子");
  }

  if (action === "limited_toggle_display") {
    let config = await getLimitedMenuConfig(env);
    config.limitedItems = Array.isArray(config.limitedItems) ? config.limitedItems : [];
    const item = config.limitedItems.find(x => cleanLimitedId(x.id) === id);
    if (!item || item.deleted === true) return stop(env, cq, "找不到可顯示豆子");

    item.active = true;
    let ids = currentLimitedBeanIdsV191(config);
    if (ids.includes(id)) {
      ids = ids.filter(x => x !== id);
    } else {
      ids = [id, ...ids].slice(0, 2);
    }
    config.currentLimitedBeanIds = ids;
    config.currentLimitedBeanId = ids[0] || "";
    config.updatedAt = new Date().toISOString();
    await saveLimitedMenuConfig(env, config);
    config = await normalizeLimitedCurrentV184(env, await getLimitedMenuConfig(env));

    const currentIds = currentLimitedBeansV191(config).map(x => cleanLimitedId(x.id));
    const refreshed = findLimitedItemV183(config, id);
    await editOrSendV183(env, chatId, messageId, limitedBeanDetailTextV187(refreshed, currentIds.includes(id)), limitedBeanDetailMarkupV187(refreshed, currentIds.includes(id)));
    return stop(env, cq, currentIds.includes(id) ? "已加入網站顯示" : "已從網站顯示移除");
  }

  if (action === "limited_set_current") {
    let config = await getLimitedMenuConfig(env);
    config.currentLimitedBeanIds = [id, ...currentLimitedBeanIdsV191(config).filter(x => x !== id)].slice(0, 2);
    config.currentLimitedBeanId = config.currentLimitedBeanIds[0] || "";
    await saveLimitedMenuConfig(env, config);
    return _oldHandleLimitedMenuActionV191(env, cq, "limited_detail:" + id);
  }

  return _oldHandleLimitedMenuActionV191(env, cq, data);
};


/* V239: member lifetime stats and free-drink vouchers count picked_up orders only.
   Recompute from order history on every Telegram status change so undo / cancel can
   truly deduct cups and redeemed voucher count instead of being blocked by old counters. */
function sky31TelegramSuccessfulOrderV199(order) {
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
  if (a.length > 3 && a.startsWith("853") && a.slice(3) === b) return true;
  if (b.length > 3 && b.startsWith("853") && b.slice(3) === a) return true;
  const aa = a.length > 8 ? a.slice(-8) : a;
  const bb = b.length > 8 ? b.slice(-8) : b;
  return !!aa && aa === bb;
}

function sky31PhoneCandidatesV239(phone) {
  phone = normalizePhone(phone);
  const out = [];
  function add(v) { v = normalizePhone(v); if (v && !out.includes(v)) out.push(v); }
  add(phone);
  if (phone.length === 8) add("853" + phone);
  if (phone.length > 8) add(phone.slice(-8));
  if (phone.length > 3 && phone.startsWith("853")) add(phone.slice(3));
  return out;
}

async function sky31CollectOrderNosForMemberV239(env, phone, changedOrderNo) {
  const orderNos = new Set();
  const candidates = sky31PhoneCandidatesV239(phone);
  for (const candidate of candidates) {
    for (const prefix of ["phone:" + candidate + ":", "member_ordered:" + candidate + ":"]) {
      let cursor = undefined;
      do {
        const page = await env.ORDERS.list({ prefix, cursor });
        for (const key of (page.keys || [])) {
          const no = String(key.name || "").replace(prefix, "").trim();
          if (no) orderNos.add(no);
        }
        cursor = page.cursor;
        if (page.list_complete !== false) break;
      } while (cursor);
    }
  }

  changedOrderNo = String(changedOrderNo || "").trim();
  if (changedOrderNo) orderNos.add(changedOrderNo);
  return Array.from(orderNos);
}

async function recalcMemberFromOrdersV199(env, changedOrder) {
  const phone = normalizePhone(changedOrder && (changedOrder.memberPhone || changedOrder.phone || changedOrder.submittedPhone));
  if (!phone || !env || !env.ORDERS || !changedOrder) return;

  const candidates = sky31PhoneCandidatesV239(phone);
  const memberEntries = [];
  const seenKeys = new Set();
  for (const candidate of candidates) {
    const key = "member:" + candidate;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const raw = await env.ORDERS.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && !parsed.deletedAt) memberEntries.push({ key, member: parsed });
    } catch (_) {}
  }
  if (!memberEntries.length) return;

  const changedOrderNo = String(changedOrder.orderNo || changedOrder.orderId || "").trim();
  const orderNos = await sky31CollectOrderNosForMemberV239(env, phone, changedOrderNo);
  const successfulNos = [];
  const recentNos = [];
  let totalOrders = 0;
  let totalCups = 0;
  let totalSpent = 0;
  let rewardRedeemed = 0;
  let lastOrderAt = "";
  let lastOrderNo = "";

  for (const no of orderNos) {
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;
    let order = null;
    try { order = JSON.parse(raw); } catch (_) { continue; }
    if (!order) continue;

    const orderPhones = [order.memberPhone, order.phone, order.submittedPhone].map(normalizePhone).filter(Boolean);
    if (!orderPhones.some(p => candidates.some(c => sky31SamePhoneV199(p, c)))) continue;

    recentNos.push(no);
    const orderAt = String(order.updatedAt || order.statusUpdatedAt || order.createdAt || "");
    if (!lastOrderAt || orderAt.localeCompare(lastOrderAt) > 0) {
      lastOrderAt = orderAt;
      lastOrderNo = String(order.orderNo || no);
    }

    if (!sky31TelegramSuccessfulOrderV199(order)) continue;
    successfulNos.push(String(order.orderNo || no));
    totalOrders += 1;
    totalCups += Math.max(0, Number(orderCupsForMemberQuery(order) || 0));
    totalSpent += Math.max(0, Number(order.totalAmount || cartTotalForMemberQuery(order.cart) || 0));
    rewardRedeemed += Math.max(0, Number(order.rewardUse || order.rewardUseRequested || 0));
  }

  totalSpent = Math.round(totalSpent * 100) / 100;
  const now = new Date().toISOString();
  const ttl = 60 * 60 * 24 * 3650;

  for (const entry of memberEntries) {
    const member = { ...entry.member };
    member.phone = normalizePhone(member.phone || entry.key.replace(/^member:/, "") || phone);
    member.totalOrders = totalOrders;
    member.totalCups = totalCups;
    member.totalSpent = totalSpent;
    member.rewardRedeemed = rewardRedeemed;
    member.rewardsRedeemed = rewardRedeemed;
    member.countedRewardOrderNos = Array.from(new Set(successfulNos)).slice(0, 5000);
    member.recentOrderNos = Array.from(new Set(recentNos)).slice(0, 2000);
    member.lastOrderAt = lastOrderAt || member.lastOrderAt || "";
    member.lastOrderNo = lastOrderNo || member.lastOrderNo || "";
    member.updatedAt = now;
    await env.ORDERS.put(entry.key, JSON.stringify(member), { expirationTtl: ttl });
  }
}


/* V223: Clean Member Admin Fix.
   Single source of truth for Telegram member query, birthday edit, tier edit,
   duplicate merge cleanup, and maintenance mode. No stacked member admin overrides below. */

const MEMBER_EDIT_DRAFT_TTL_V223 = 60 * 10;
const MEMBER_EDIT_DRAFT_PREFIX_V223 = "member_edit_draft:v223:";
const MAINTENANCE_KEY_V223 = "sky31:maintenance:v1";

function phoneLast8V223(phone) {
  const p = normalizePhone(phone || "");
  return p.length >= 8 ? p.slice(-8) : p;
}

function canonicalPhoneV223(phone) {
  // V237: no longer force-add Macau 853. Keep the customer's input digits as canonical.
  return normalizePhone(phone || "");
}

function memberKeyV223(phone) {
  return "member:" + canonicalPhoneV223(phone);
}

function memberTimeV223(member) {
  return Math.max(
    new Date((member && member.manualTierUpdatedAt) || 0).getTime() || 0,
    new Date((member && member.birthdayUpdatedAt) || 0).getTime() || 0,
    new Date((member && member.updatedAt) || 0).getTime() || 0,
    new Date((member && member.createdAt) || 0).getTime() || 0
  );
}

function memberScoreV223(member) {
  member = member || {};
  let score = memberTimeV223(member) / 10000000000000;
  if (member.name) score += 10;
  if (member.birthday) score += 8;
  if (member.manualTierKey || member.memberTierOverrideKey || member.memberTierManualKey) score += 8;
  score += Math.min(50, Number(member.totalCups || 0));
  score += Math.min(30, Number(member.totalOrders || 0));
  score += Math.min(40, Number(member.totalSpent || 0) / 20);
  return score;
}

function mergeMemberPayloadsV223(records, phoneHint) {
  records = Array.isArray(records) ? records.filter(x => x && x.member) : [];
  records.sort((a, b) => memberScoreV223(b.member) - memberScoreV223(a.member));

  const base = records[0] ? { ...records[0].member } : {};
  const last8 = phoneLast8V223(base.phone || phoneHint || (records[0] && records[0].key) || "");
  base.phone = canonicalPhoneV223(last8);

  const orderNos = new Set(Array.isArray(base.recentOrderNos) ? base.recentOrderNos : []);

  for (const rec of records) {
    const m = rec.member || {};
    if (!base.name && m.name) base.name = m.name;
    if (!base.note && m.note) base.note = m.note;
    if (!base.createdAt || (m.createdAt && String(m.createdAt) < String(base.createdAt))) base.createdAt = m.createdAt;

    if (m.birthday && (!base.birthday || new Date(m.birthdayUpdatedAt || m.updatedAt || 0) >= new Date(base.birthdayUpdatedAt || base.updatedAt || 0))) {
      base.birthday = m.birthday;
      base.birthdayUpdatedAt = m.birthdayUpdatedAt || m.updatedAt || base.birthdayUpdatedAt || "";
      base.birthdayUpdatedBy = m.birthdayUpdatedBy || base.birthdayUpdatedBy || "";
    }

    const tierKey = m.manualTierKey || m.memberTierOverrideKey || m.memberTierManualKey || "";
    if (tierKey && (!base.manualTierKey || new Date(m.manualTierUpdatedAt || m.updatedAt || 0) >= new Date(base.manualTierUpdatedAt || base.updatedAt || 0))) {
      base.manualTierKey = tierKey;
      base.manualTierName = m.manualTierName || m.memberTierOverrideName || base.manualTierName || "";
      base.manualTierIcon = m.manualTierIcon || m.memberTierOverrideIcon || base.manualTierIcon || "";
      base.memberTierOverrideKey = tierKey;
      base.memberTierOverrideName = base.manualTierName;
      base.memberTierOverrideIcon = base.manualTierIcon;
      base.manualTierBaseCups = Number(m.manualTierBaseCups || base.manualTierBaseCups || 0);
      base.manualTierStartCups = Number(m.manualTierStartCups || m.manualTierSetAtCups || m.manualTierOriginalCups || base.manualTierStartCups || m.totalCups || 0);
      base.manualTierSetAtCups = base.manualTierStartCups;
      base.manualTierOriginalCups = base.manualTierStartCups;
      base.manualTierUpdatedAt = m.manualTierUpdatedAt || m.updatedAt || base.manualTierUpdatedAt || "";
      base.manualTierUpdatedBy = m.manualTierUpdatedBy || base.manualTierUpdatedBy || "";
    }

    base.totalOrders = Math.max(Number(base.totalOrders || 0), Number(m.totalOrders || 0));
    base.totalCups = Math.max(Number(base.totalCups || 0), Number(m.totalCups || 0));
    base.totalSpent = Math.max(Number(base.totalSpent || 0), Number(m.totalSpent || 0));
    base.rewardRedeemed = Math.max(Number(base.rewardRedeemed || base.rewardsRedeemed || 0), Number(m.rewardRedeemed || m.rewardsRedeemed || 0));
    base.rewardsRedeemed = base.rewardRedeemed;
    (Array.isArray(m.recentOrderNos) ? m.recentOrderNos : []).forEach(no => { if (no) orderNos.add(String(no)); });
  }

  base.recentOrderNos = Array.from(orderNos).slice(0, 2000);
  base.updatedAt = base.updatedAt || new Date().toISOString();
  return base;
}

async function findActiveMemberV223(env, phone) {
  const last8 = phoneLast8V223(phone);
  if (!last8) return { key: "", member: null, records: [] };

  const records = [];
  const seen = new Set();
  async function tryKey(key) {
    if (!key || seen.has(key)) return;
    seen.add(key);
    const raw = await env.ORDERS.get(key);
    if (!raw) return;
    try {
      const member = JSON.parse(raw);
      if (!member || member.deletedAt) return;
      const p = normalizePhone(member.phone || key.replace("member:", ""));
      if (p.slice(-8) === last8 || normalizePhone(key).slice(-8) === last8) {
        member.phone = p || canonicalPhoneV223(last8);
        member._kvKey = key;
        records.push({ key, member });
      }
    } catch (_) {}
  }

  await tryKey("member:" + last8);
  await tryKey("member:853" + last8);
  await tryKey("member:" + normalizePhone(phone));

  let cursor = undefined;
  let checked = 0;
  do {
    const page = await env.ORDERS.list({ prefix: "member:", cursor });
    for (const key of (page.keys || [])) {
      checked += 1;
      if (checked > 8000) break;
      await tryKey(key.name);
    }
    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor && checked <= 8000);

  if (!records.length) return { key: "", member: null, records: [] };

  const member = mergeMemberPayloadsV223(records, last8);
  const key = memberKeyV223(member.phone);
  member._kvKey = key;
  return { key, member, records };
}

async function saveActiveMemberV223(env, loaded) {
  if (!loaded || !loaded.member) return null;
  const member = { ...loaded.member };
  const last8 = phoneLast8V223(member.phone);
  member.phone = canonicalPhoneV223(member.phone || (loaded.key || "").replace(/^member:/, ""));
  member.updatedAt = new Date().toISOString();

  const canonicalKey = memberKeyV223(member.phone);
  await env.ORDERS.put(canonicalKey, JSON.stringify(member), { expirationTtl: 60 * 60 * 24 * 3650 });

  const keysToDelete = new Set();
  (Array.isArray(loaded.records) ? loaded.records : []).forEach(rec => {
    if (rec && rec.key && rec.key !== canonicalKey) keysToDelete.add(rec.key);
  });

  let cursor = undefined;
  do {
    const page = await env.ORDERS.list({ prefix: "member:", cursor });
    for (const key of (page.keys || [])) {
      if (key.name === canonicalKey) continue;
      const kp = normalizePhone(key.name.replace("member:", ""));
      if (kp.slice(-8) === last8) keysToDelete.add(key.name);
    }
    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);

  for (const key of keysToDelete) {
    await env.ORDERS.delete(key);
  }

  return { key: canonicalKey, member, deletedAliasCount: keysToDelete.size };
}

function normalizeBirthdayInputV223(input) {
  let s = String(input || "").trim();
  if (!s) return "";
  s = s.replace(/[．。]/g, ".")
       .replace(/[\/\.]/g, "-")
       .replace(/年/g, "-")
       .replace(/月/g, "-")
       .replace(/日/g, "")
       .replace(/\s+/g, "");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) return "";
  return String(y).padStart(4, "0") + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

function birthdayValidV211(value) {
  return !!normalizeBirthdayInputV223(value);
}

function memberTierListV211() {
  return [
    { key: "regular", name: "普通會員", icon: "🌱", cups: 0 },
    { key: "silver", name: "銀卡會員", icon: "🥈", cups: 30 },
    { key: "gold", name: "金卡會員", icon: "🥇", cups: 60 },
    { key: "diamond", name: "鑽石會員", icon: "💎", cups: 100 },
    { key: "blackgold", name: "黑金會員", icon: "👑", cups: 180 }
  ];
}

function memberTierByKeyV211(key) {
  key = String(key || "").toLowerCase();
  if (key === "vip") key = "blackgold";
  return memberTierListV211().find(t => t.key === key) || null;
}

function memberTierByCupsV211(cups) {
  cups = Number(cups || 0);
  let current = memberTierListV211()[0];
  memberTierListV211().forEach(t => { if (cups >= t.cups) current = t; });
  return current;
}

function memberDisplayTierV211(member) {
  member = member || {};
  const totalCups = Number(member.totalCups || member.cups || member.totalItems || 0);
  const manualBase = memberTierByKeyV211(member.manualTierKey || member.memberTierOverrideKey || member.memberTierManualKey || "");
  if (!manualBase) return { ...memberTierByCupsV211(totalCups), manual: false };

  const start = Number(member.manualTierStartCups || member.manualTierSetAtCups || member.manualTierOriginalCups || totalCups || 0);
  const base = Number(member.manualTierBaseCups || manualBase.cups || 0);
  const effective = base + Math.max(0, totalCups - start);
  const tier = memberTierByCupsV211(effective);
  const next = memberTierListV211().find(t => t.cups > effective) || null;
  return { ...tier, manual: true, manualBase, effectiveCups: effective, gainedSinceManualTier: Math.max(0, totalCups - start), nextTier: next, cupsToNext: next ? Math.max(0, next.cups - effective) : 0 };
}

function memberDraftKeyV223(chatId) {
  return MEMBER_EDIT_DRAFT_PREFIX_V223 + String(chatId || "");
}

async function saveMemberEditDraftV211(env, chatId, draft) {
  await env.ORDERS.put(memberDraftKeyV223(chatId), JSON.stringify(draft || {}), { expirationTtl: MEMBER_EDIT_DRAFT_TTL_V223 });
}

async function getMemberEditDraftV211(env, chatId) {
  const raw = await env.ORDERS.get(memberDraftKeyV223(chatId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function clearMemberEditDraftV211(env, chatId) {
  await env.ORDERS.delete(memberDraftKeyV223(chatId));
}

async function loadActiveMemberForEditV211(env, phone) {
  return findActiveMemberV223(env, phone);
}

async function saveActiveMemberForEditV211(env, loaded) {
  return saveActiveMemberV223(env, loaded);
}

listMembersByPrefix = async function(env, prefix, deleted) {
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
        member._kvKey = key.name;
        out.push(member);
      } catch (_) {}
    }
    cursor = page.cursor;
    if (page.list_complete !== false) break;
  } while (cursor);
  return out;
};

function dedupeMembersV223(members) {
  const groups = new Map();
  (Array.isArray(members) ? members : []).forEach(member => {
    const key = phoneLast8V223(member.phone || member._kvKey || "");
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ key: member._kvKey || "", member });
  });
  const out = [];
  groups.forEach(records => {
    const activeRecords = records.filter(r => !r.member._deleted);
    const chosenRecords = activeRecords.length ? activeRecords : records;
    const merged = mergeMemberPayloadsV223(chosenRecords, records[0] && records[0].member && records[0].member.phone);
    merged._deleted = !activeRecords.length;
    merged._duplicateCount = records.length;
    out.push(merged);
  });
  return out;
}

listTelegramMembers = async function(env) {
  let members = (await listMembersByPrefix(env, "member:", false)).concat(await listMembersByPrefix(env, "member_deleted:", true));
  members = dedupeMembersV223(members);
  members.sort((a, b) => {
    if (a._deleted !== b._deleted) return a._deleted ? 1 : -1;
    return memberTimeV223(b) - memberTimeV223(a);
  });
  return members;
};

buildMemberListText = function(members) {
  const activeCount = members.filter(m => !m._deleted).length;
  const deletedCount = members.filter(m => m._deleted).length;
  const hidden = members.reduce((s, m) => s + Math.max(0, Number(m._duplicateCount || 1) - 1), 0);
  const lines = [];
  lines.push("👥 SKY31 用戶查詢");
  lines.push("");
  lines.push("有效會員：" + activeCount);
  lines.push("已刪除會員：" + deletedCount);
  if (hidden > 0) lines.push("已合併顯示重複會員 alias：" + hidden);
  lines.push("");
  lines.push(members.length ? "請點擊下方用戶查看詳細資料。" : "目前未有會員資料。");
  return lines.join("\n").trim();
};

buildMemberListMarkup = function(members) {
  const rows = [];
  members.slice(0, 80).forEach(member => {
    const phone = phoneLast8V223(member.phone);
    const displayPhone = canonicalPhoneV223(phone);
    const name = member.name || "未命名";
    const deleted = !!member._deleted;
    rows.push([{ text: ((deleted ? "🗑️ " : "👤 ") + name + "｜" + displayPhone + (deleted ? "｜已刪除" : "")).slice(0, 60), callback_data: (deleted ? "member_view_deleted:" : "member_view_active:") + phone }]);
  });
  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
};

getMemberForTelegramView = async function(env, phone, deleted) {
  if (deleted) {
    const last8 = phoneLast8V223(phone);
    let cursor = undefined;
    do {
      const page = await env.ORDERS.list({ prefix: "member_deleted:", cursor });
      for (const key of (page.keys || [])) {
        const raw = await env.ORDERS.get(key.name);
        if (!raw) continue;
        try {
          const member = JSON.parse(raw);
          const p = normalizePhone(member.phone || key.name.replace("member_deleted:", ""));
          if (p.slice(-8) === last8) {
            member._deleted = true;
            member._kvKey = key.name;
            return member;
          }
        } catch (_) {}
      }
      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor);
    return null;
  }
  const loaded = await findActiveMemberV223(env, phone);
  return loaded.member;
};

handleMemberQueryAction = async function(env, cq, data) {
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
    const deleted = action === "member_view_deleted";
    let member = await getMemberForTelegramView(env, arg, deleted);
    if (!member && !deleted) member = await getMemberForTelegramView(env, arg, true);
    if (!member) {
      const members = await listTelegramMembers(env);
      await editTelegramMessage(env, chatId, messageId, buildMemberListText(members), buildMemberListMarkup(members));
      return stop(env, cq, "找不到會員資料，已重新整理列表");
    }
    if (!member._deleted) member = await enrichMemberStatsForTelegram(env, member).catch(() => member);
    await editTelegramMessage(env, chatId, messageId, buildMemberDetailText(member, !!member._deleted), buildMemberDetailReplyMarkup(member, !!member._deleted));
    return stop(env, cq, "已載入會員資料");
  }

  return stop(env, cq, "未知會員查詢操作");
};

buildMemberDetailText = function(member, deleted = false) {
  const tier = memberDisplayTierV211(member);
  const lines = [];
  lines.push("👤 SKY31 會員詳細資料");
  lines.push("");
  lines.push(deleted ? "狀態：已刪除" : "狀態：有效會員｜等級：" + tier.name + " " + tier.icon);
  lines.push("姓名：" + (member.name || "-"));
  lines.push("電話：" + (member.phone || "-"));
  lines.push("生日：" + (member.birthday || "-"));
  if (member.note) lines.push("備註：" + member.note);
  if (member.createdAt) lines.push("註冊時間：" + formatDateTime(member.createdAt));
  if (member.manualTierUpdatedAt && !deleted) lines.push("等級修改時間：" + formatDateTime(member.manualTierUpdatedAt));
  if (member.birthdayUpdatedAt && !deleted) lines.push("生日修改時間：" + formatDateTime(member.birthdayUpdatedAt));
  lines.push("");
  lines.push("累積訂單：" + Number(member.totalOrders || 0));
  lines.push("累積杯數：" + Number(member.totalCups || 0));
  lines.push("累積消費：MOP " + String(Math.round(Number(member.totalSpent || 0) * 100) / 100));

  const recent = Array.isArray(member.recentOrders) ? member.recentOrders : [];
  if (recent.length) {
    lines.push("");
    lines.push("最近訂單：");
    recent.forEach(order => lines.push("#" + order.orderNo + "｜" + statusLabel(order.status) + "｜" + Number(order.cups || 0) + "杯｜MOP " + String(Math.round(Number(order.totalAmount || 0) * 100) / 100)));
  }

  lines.push("");
  lines.push(deleted ? "此會員已刪除。" : "可在下方修改生日 / 會員等級。");
  return lines.join("\n").trim();
};

buildMemberDetailReplyMarkup = function(member, deleted = false) {
  const phone = phoneLast8V223(member.phone);
  const rows = [];
  if (deleted) {
    rows.push([{ text: "↩️ 恢復賬號", callback_data: "member_restore:" + phone }]);
  } else {
    rows.push([{ text: "🔄 重新讀取會員資料", callback_data: "member_refresh:" + phone }]);
    rows.push([{ text: "🏅 更改會員等級", callback_data: "member_tier_menu:" + phone }]);
    rows.push([{ text: "🗑️ 刪除賬號", callback_data: "member_delete:" + phone }]);
  }
  rows.push([{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]);
  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
};

async function handleMemberAdminEditActionV211(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;
  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");

  const parts = String(data || "").split(":");
  const action = parts[0];
  const phone = phoneLast8V223(parts[1] || "");
  if (!phone) return stop(env, cq, "找不到會員電話");

  if (action === "member_refresh" || action === "member_edit_cancel") {
    await clearMemberEditDraftV211(env, chatId);
    const loaded = await findActiveMemberV223(env, phone);
    if (!loaded.member) return stop(env, cq, "找不到會員資料");
    const enriched = await enrichMemberStatsForTelegram(env, loaded.member).catch(() => loaded.member);
    await editTelegramMessage(env, chatId, messageId, buildMemberDetailText(enriched, false), buildMemberDetailReplyMarkup(enriched, false));
    return stop(env, cq, action === "member_refresh" ? "已重新讀取會員資料" : "已取消");
  }

  if (action === "member_edit_birthday") {
    await clearMemberEditDraftV211(env, chatId);
    return stop(env, cq, "後台修改生日功能已停用，請由會員本人於會員中心設定。");
  }

  if (action === "member_tier_menu") {
    const loaded = await findActiveMemberV223(env, phone);
    if (!loaded.member) return stop(env, cq, "找不到會員資料，請返回列表重新選擇");
    const rows = memberTierListV211().map(t => ([{ text: t.icon + " " + t.name + "｜" + (t.cups === 0 ? "加入即成為會員" : "累計 " + t.cups + " 杯起"), callback_data: "member_tier_set:" + phone + ":" + t.key }]));
    rows.push([{ text: "取消", callback_data: "member_edit_cancel:" + phone }]);
    await editTelegramMessage(env, chatId, messageId, "🏅 更改會員等級\n\n請選擇要設定的會員等級。", { inline_keyboard: rows });
    return stop(env, cq, "請選擇會員等級");
  }

  if (action === "member_tier_set") {
    const tier = memberTierByKeyV211(parts[2] || "");
    if (!tier) return stop(env, cq, "會員等級無效");
    const loaded = await findActiveMemberV223(env, phone);
    if (!loaded.member) return stop(env, cq, "找不到會員資料，請返回列表重新選擇");

    const stats = await enrichMemberStatsForTelegram(env, loaded.member).catch(() => loaded.member);
    const currentCups = Number(stats.totalCups || loaded.member.totalCups || 0);
    loaded.member.totalCups = Math.max(Number(loaded.member.totalCups || 0), currentCups);
    loaded.member.manualTierKey = tier.key;
    loaded.member.manualTierName = tier.name;
    loaded.member.manualTierIcon = tier.icon;
    loaded.member.manualTierBaseCups = Number(tier.cups || 0);
    loaded.member.manualTierStartCups = currentCups;
    loaded.member.manualTierSetAtCups = currentCups;
    loaded.member.manualTierOriginalCups = currentCups;
    loaded.member.memberTierOverrideKey = tier.key;
    loaded.member.memberTierOverrideName = tier.name;
    loaded.member.memberTierOverrideIcon = tier.icon;
    loaded.member.manualTierUpdatedAt = new Date().toISOString();
    loaded.member.manualTierUpdatedBy = "telegram";

    const saved = await saveActiveMemberV223(env, loaded);
    const enriched = await enrichMemberStatsForTelegram(env, saved.member).catch(() => saved.member);
    await editTelegramMessage(env, chatId, messageId, buildMemberDetailText(enriched, false), buildMemberDetailReplyMarkup(enriched, false));
    return stop(env, cq, "已更改會員等級：" + tier.name);
  }

  return stop(env, cq, "未知會員編輯操作");
}

async function handleMemberEditDraftTextV211(env, message, text, draft) {
  const chatId = message.chat && message.chat.id ? message.chat.id : env.TELEGRAM_CHAT_ID;
  if (!isAuthorizedTelegramChat(env, chatId)) {
    await clearMemberEditDraftV211(env, chatId);
    return json({ ok: true });
  }

  const raw = String(text || "").trim();
  if (raw === "取消") {
    await clearMemberEditDraftV211(env, chatId);
    await sendTelegramMessage(env, chatId, "已取消會員資料修改。", buildCommandMenuMarkupV183 ? buildCommandMenuMarkupV183() : null);
    return json({ ok: true });
  }

  if (draft && draft.type === "birthday") {
    await clearMemberEditDraftV211(env, chatId);
    await sendTelegramMessage(env, chatId, "後台修改生日功能已停用，請由會員本人於會員中心設定。", buildCommandMenuMarkupV183 ? buildCommandMenuMarkupV183() : null);
    return json({ ok: true });
  }

  await clearMemberEditDraftV211(env, chatId);
  await sendTelegramMessage(env, chatId, "未找到正在編輯的會員資料，請重新進入會員詳細頁操作。", buildCommandMenuMarkupV183 ? buildCommandMenuMarkupV183() : null);
  return json({ ok: true });
}

/* Maintenance mode retained from previous versions, cleanly implemented here. */
async function getMaintenanceConfigV218(env) {
  try {
    const raw = await env.ORDERS.get(MAINTENANCE_KEY_V223);
    if (!raw) return { active: false, message: "", updatedAt: "", updatedBy: "" };
    const config = JSON.parse(raw);
    return { active: config && config.active === true, message: String((config && config.message) || "Sky31 正在短暫維護，我們正在更新點餐系統及會員資料，暫時未能下單或查詢訂單。"), updatedAt: String((config && config.updatedAt) || ""), updatedBy: String((config && config.updatedBy) || "") };
  } catch (_) {
    return { active: false, message: "", updatedAt: "", updatedBy: "" };
  }
}

async function setMaintenanceConfigV223(env, active, by) {
  const config = { active: active === true, message: active === true ? "Sky31 正在短暫維護，我們正在更新點餐系統及會員資料，暫時未能下單或查詢訂單。" : "", updatedAt: new Date().toISOString(), updatedBy: String(by || "telegram") };
  await env.ORDERS.put(MAINTENANCE_KEY_V223, JSON.stringify(config));
  return config;
}

function buildMaintenanceTextV223(config) {
  return ["🛠 Sky31 系統維護", "", "目前狀態：" + (config && config.active ? "維護中，網站暫停使用" : "正常開放"), config && config.updatedAt ? "更新時間：" + formatDateTime(config.updatedAt) : "", "", config && config.active ? "客人打開網站時會停留在維護視窗，直到你按「取消維護」。" : "按「啟用維護」後，網站會即時彈出維護視窗並暫停所有操作。"].filter(Boolean).join("\n");
}

function buildMaintenanceMarkupV223(config) {
  const rows = [];
  if (config && config.active) rows.push([{ text: "✅ 取消維護，恢復使用", callback_data: "maint_off:x" }]);
  else rows.push([{ text: "🛠 啟用維護，暫停使用", callback_data: "maint_on:x" }]);
  rows.push([{ text: "🔄 重新整理狀態", callback_data: "maint_status:x" }]);
  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
}

async function handleMaintenanceActionV218(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;
  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");
  let config = await getMaintenanceConfigV218(env);
  if (String(data || "").startsWith("maint_on:")) config = await setMaintenanceConfigV223(env, true, "telegram");
  if (String(data || "").startsWith("maint_off:")) config = await setMaintenanceConfigV223(env, false, "telegram");
  await editTelegramMessage(env, chatId, messageId, buildMaintenanceTextV223(config), buildMaintenanceMarkupV223(config));
  return stop(env, cq, config.active ? "維護模式已啟用" : "維護模式已取消");
}

/* Duplicate merge retained, using the same clean V223 member lookup/merge logic. */
async function mergeDuplicateMembersV223(env, dryRun = true) {
  const active = await listMembersByPrefix(env, "member:", false);
  const groups = new Map();
  active.forEach(member => {
    const last8 = phoneLast8V223(member.phone || member._kvKey);
    if (!last8) return;
    if (!groups.has(last8)) groups.set(last8, []);
    groups.get(last8).push({ key: member._kvKey || ("member:" + normalizePhone(member.phone)), member });
  });

  const details = [];
  let keysDeleted = 0;
  let groupsMerged = 0;

  for (const [last8, records] of groups.entries()) {
    if (records.length <= 1) continue;
    const member = mergeMemberPayloadsV223(records, last8);
    member.phone = canonicalPhoneV223(last8);
    const canonicalKey = memberKeyV223(last8);
    const remove = records.map(r => r.key).filter(k => k && k !== canonicalKey);
    details.push({ phone: member.phone, count: records.length, keep: canonicalKey, remove });
    if (!dryRun) {
      await env.ORDERS.put(canonicalKey, JSON.stringify(member), { expirationTtl: 60 * 60 * 24 * 3650 });
      for (const key of remove) {
        await env.ORDERS.delete(key);
        keysDeleted += 1;
      }
      groupsMerged += 1;
    }
  }

  return { totalMemberKeys: active.length, duplicateGroups: details.length, groupsMerged, keysDeleted, details };
}

function buildMemberDuplicateMergeTextV223(result) {
  const lines = [];
  lines.push("🧹 合併重複會員");
  lines.push("");
  lines.push("會員 KV 數量：" + Number(result.totalMemberKeys || 0));
  lines.push("重複會員組數：" + Number(result.duplicateGroups || 0));
  if (result.groupsMerged) lines.push("已合併組數：" + Number(result.groupsMerged || 0));
  if (result.keysDeleted) lines.push("已刪除多餘 alias：" + Number(result.keysDeleted || 0));
  lines.push("");
  if (!result.duplicateGroups) lines.push("目前沒有需要合併的重複會員。");
  else (result.details || []).slice(0, 12).forEach(d => lines.push("• " + d.phone + "｜保留 " + d.keep + "｜刪除 " + d.remove.length + " 個 alias"));
  lines.push("");
  lines.push("只會合併 member:* alias，不會刪除 order:* 訂單或 phone:* 索引。");
  return lines.join("\n").trim();
}

function buildMemberDuplicateMergeMarkupV223(result) {
  const rows = [];
  if (result && result.duplicateGroups) rows.push([{ text: "⚠️ 確認合併並刪除多餘 alias", callback_data: "member_merge_confirm:x" }]);
  rows.push([{ text: "📋 查看會員列表", callback_data: "member_list:all" }]);
  rows.push([{ text: "🔄 重新掃描", callback_data: "member_merge_duplicates:x" }]);
  rows.push([{ text: "返回功能列表", callback_data: "limited_cmd_menu:x" }]);
  return { inline_keyboard: rows };
}

async function handleMemberDuplicateMergeActionV219(env, cq, data) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
  const messageId = cq.message ? cq.message.message_id : null;
  if (!isAuthorizedTelegramChat(env, chatId)) return stop(env, cq, "沒有權限");
  const confirm = String(data || "").startsWith("member_merge_confirm:");
  const result = await mergeDuplicateMembersV223(env, !confirm);
  await editTelegramMessage(env, chatId, messageId, buildMemberDuplicateMergeTextV223(result), buildMemberDuplicateMergeMarkupV223(result));
  return stop(env, cq, confirm ? "已完成合併重複會員" : "已完成掃描");
}

buildCommandMenuMarkupV183 = function() {
  return {
    inline_keyboard: [
      [{ text: "➕ 新增限定豆子", callback_data: "limited_wizard_add:x" }],
      [{ text: "✨ 限定豆子列表 / 編輯", callback_data: "limited_list:all" }],
      [{ text: "👤 查詢會員", callback_data: "member_list:active:0" }],
      [{ text: "🧹 合併重複會員", callback_data: "member_merge_duplicates:x" }],
      [{ text: "🛠 系統維護", callback_data: "maint_status:x" }]
    ]
  };
};


/* V237 member admin phone/delete fix: no forced 853, robust legacy alias cleanup. */
function memberLookupPhoneV221(member) {
  member = member || {};
  return normalizePhone(member.phone || String(member._kvKey || "").replace(/^member_deleted:|^member:/, ""));
}

function phoneWithoutForced853V237(phone) {
  phone = normalizePhone(phone || "");
  if (phone.length > 3 && phone.startsWith("853")) return phone.slice(3);
  return phone;
}

function legacyMemberPhonesV237(phone) {
  const p = normalizePhone(phone || "");
  const stripped = phoneWithoutForced853V237(p);
  const last8 = p.length >= 8 ? p.slice(-8) : p;
  const strippedLast8 = stripped.length >= 8 ? stripped.slice(-8) : stripped;
  const out = [];
  [p, stripped, last8, strippedLast8].forEach(x => { if (x) out.push(x); });
  [last8, strippedLast8, stripped].forEach(x => { if (x) out.push("853" + x); });
  return Array.from(new Set(out.map(normalizePhone).filter(Boolean)));
}

async function findMemberRecordV237(env, phone, preferDeleted) {
  phone = normalizePhone(phone || "");
  const candidates = legacyMemberPhonesV237(phone);
  const prefixes = preferDeleted ? ["member_deleted:", "member:"] : ["member:", "member_deleted:"];
  const wantedLast = phone.length >= 8 ? phone.slice(-8) : phoneWithoutForced853V237(phone);

  for (const prefix of prefixes) {
    for (const c of candidates) {
      const key = prefix + c;
      const raw = await env.ORDERS.get(key);
      if (!raw) continue;
      try {
        const member = JSON.parse(raw);
        if (!member) continue;
        const stored = normalizePhone(member.phone || c);
        const storedLast = stored.length >= 8 ? stored.slice(-8) : phoneWithoutForced853V237(stored);
        if (stored === phone || candidates.includes(stored) || storedLast === wantedLast || normalizePhone(c).slice(-8) === wantedLast) {
          member.phone = stored || c || phone;
          member._kvKey = key;
          member._deleted = prefix === "member_deleted:";
          return { key, member, deleted: prefix === "member_deleted:" };
        }
      } catch (_) {}
    }
  }

  for (const prefix of prefixes) {
    let cursor = undefined;
    let checked = 0;
    do {
      const page = await env.ORDERS.list({ prefix, cursor });
      for (const key of (page.keys || [])) {
        checked += 1;
        if (checked > 8000) break;
        const keyPhone = normalizePhone(String(key.name || "").replace(prefix, ""));
        const keyLast = keyPhone.length >= 8 ? keyPhone.slice(-8) : phoneWithoutForced853V237(keyPhone);
        if (wantedLast && keyLast !== wantedLast && !candidates.includes(keyPhone)) continue;
        const raw = await env.ORDERS.get(key.name);
        if (!raw) continue;
        try {
          const member = JSON.parse(raw);
          if (!member) continue;
          const stored = normalizePhone(member.phone || keyPhone);
          const storedLast = stored.length >= 8 ? stored.slice(-8) : phoneWithoutForced853V237(stored);
          if (storedLast === wantedLast || keyLast === wantedLast || candidates.includes(stored) || candidates.includes(keyPhone)) {
            member.phone = stored || keyPhone || phone;
            member._kvKey = key.name;
            member._deleted = prefix === "member_deleted:";
            return { key: key.name, member, deleted: prefix === "member_deleted:" };
          }
        } catch (_) {}
      }
      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor && checked <= 8000);
  }
  return null;
}

getAnyMember = async function(env, phone) {
  const found = await findMemberRecordV237(env, phone, false);
  return found ? found.member : null;
};

deleteMemberOrders = async function(env, phone) {
  const phones = legacyMemberPhonesV237(phone);
  const orderNos = new Set();

  for (const p of phones) {
    let cursor = undefined;
    const prefix = "phone:" + p + ":";
    do {
      const page = await env.ORDERS.list({ prefix, cursor });
      for (const key of (page.keys || [])) {
        const orderNo = key.name.replace(prefix, "");
        if (orderNo) orderNos.add(orderNo);
      }
      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor);

    cursor = undefined;
    const mprefix = "member_ordered:" + p + ":";
    do {
      const page = await env.ORDERS.list({ prefix: mprefix, cursor });
      for (const key of (page.keys || [])) {
        const orderNo = key.name.replace(mprefix, "");
        if (orderNo) orderNos.add(orderNo);
      }
      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor);
  }

  let deletedOrders = 0;
  const deletedNos = [];
  for (const orderNo of Array.from(orderNos)) {
    const orderRaw = await env.ORDERS.get("order:" + orderNo);
    if (orderRaw) {
      const archivePhone = normalizePhone(phone || "");
      await env.ORDERS.put("member_deleted_order:" + archivePhone + ":" + orderNo, orderRaw);
      await env.ORDERS.delete("order:" + orderNo);
      deletedOrders += 1;
      deletedNos.push(orderNo);
    }
    for (const p of phones) {
      const phoneKey = "phone:" + p + ":" + orderNo;
      const markerKey = "member_ordered:" + p + ":" + orderNo;
      const phoneRaw = await env.ORDERS.get(phoneKey);
      const markerRaw = await env.ORDERS.get(markerKey);
      if (phoneRaw != null) await env.ORDERS.put("member_deleted_phone_index:" + normalizePhone(phone || "") + ":" + orderNo + ":" + p, phoneRaw);
      if (markerRaw != null) await env.ORDERS.put("member_deleted_order_marker:" + normalizePhone(phone || "") + ":" + orderNo + ":" + p, markerRaw);
      await env.ORDERS.delete(phoneKey);
      await env.ORDERS.delete(markerKey);
    }
  }

  return { deletedOrders, deletedIndexKeys: deletedNos.length * phones.length * 2, orderNos: deletedNos };
};

handleMemberAction = async function(env, cq, data) {
  try {
    const sep = data.indexOf(":");
    const action = sep >= 0 ? data.slice(0, sep) : "";
    const requestedPhone = normalizePhone(sep >= 0 ? data.slice(sep + 1) : "");
    if (!requestedPhone) return stop(env, cq, "找不到會員電話");

    const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
    const messageId = cq.message ? cq.message.message_id : null;

    if (action === "member_delete") {
      const found = await findMemberRecordV237(env, requestedPhone, false);
      if (!found || found.deleted) return stop(env, cq, "找不到有效會員資料");
      const phone = normalizePhone(found.member.phone || requestedPhone);
      await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(found.member, false, true), {
        inline_keyboard: [[
          { text: "✅ 確認刪除", callback_data: "member_delete_confirmed:" + phone },
          { text: "取消", callback_data: "member_cancel_delete:" + phone }
        ], [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]]
      });
      return stop(env, cq, "請再次確認是否刪除會員");
    }

    if (action === "member_cancel_delete") {
      const found = await findMemberRecordV237(env, requestedPhone, false);
      if (!found) return stop(env, cq, "找不到會員資料");
      await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(found.member, !!found.deleted, false), buildMemberReplyMarkup(found.member, !!found.deleted));
      return stop(env, cq, "已取消刪除");
    }

    if (action === "member_delete_confirmed") {
      const found = await findMemberRecordV237(env, requestedPhone, false);
      if (!found) {
        const deletedFound = await findMemberRecordV237(env, requestedPhone, true);
        if (deletedFound) {
          await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(deletedFound.member, true, false), buildMemberReplyMarkup(deletedFound.member, true));
          return stop(env, cq, "此會員資料已刪除");
        }
        return stop(env, cq, "找不到有效會員資料");
      }
      if (found.deleted) return stop(env, cq, "此會員資料已刪除");

      const member = found.member;
      const phone = normalizePhone(member.phone || requestedPhone);
      const deletePhones = legacyMemberPhonesV237(phone || requestedPhone);
      const deletedOrderResult = await deleteMemberOrders(env, phone || requestedPhone);

      member.deletedAt = new Date().toISOString();
      member.deletedBy = "telegram";
      member.updatedAt = member.deletedAt;
      member.deletedOrders = deletedOrderResult.deletedOrders || 0;
      member.deletedOrderNos = deletedOrderResult.orderNos || [];
      member.totalOrders = 0;
      member.totalCups = 0;
      member.totalSpent = 0;
      member.recentOrderNos = [];
      member.lastOrderNo = "";
      member.lastOrderAt = "";

      const deletedKey = "member_deleted:" + phone;
      await env.ORDERS.put(deletedKey, JSON.stringify(member));
      const keysToDelete = new Set([found.key]);
      deletePhones.forEach(p => keysToDelete.add("member:" + p));
      for (const key of keysToDelete) {
        if (key && key !== deletedKey) await env.ORDERS.delete(key);
      }

      await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(member, true, false), buildMemberReplyMarkup(member, true));
      return stop(env, cq, "已刪除會員及相關訂單 " + phone);
    }

    if (action === "member_restore") {
      const found = await findMemberRecordV237(env, requestedPhone, true);
      if (!found) return stop(env, cq, "沒有可撤回的會員資料");
      if (!found.deleted) {
        await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(found.member, false, false), buildMemberReplyMarkup(found.member, false));
        return stop(env, cq, "此會員目前已是有效狀態");
      }
      const member = found.member;
      const phone = normalizePhone(member.phone || requestedPhone);
      delete member.deletedAt;
      delete member.deletedBy;
      member.restoredAt = new Date().toISOString();
      member.updatedAt = member.restoredAt;
      await env.ORDERS.put("member:" + phone, JSON.stringify(member));
      await env.ORDERS.delete(found.key);
      await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(member, false, false), buildMemberReplyMarkup(member, false));
      return stop(env, cq, "已恢復會員 " + phone);
    }

    return stop(env, cq, "未知會員操作");
  } catch (e) {
    try { return stop(env, cq, "操作失敗：" + (e.message || "未知錯誤")); }
    catch (_) { return json({ ok: false, error: e.message || "member action failed" }, 500); }
  }
};


/* V238: Telegram permanent member delete. Purged members are hidden from Telegram lists forever unless KV tombstones are manually removed. */
function memberPurgeCandidatePhonesV238(phone) {
  if (typeof legacyMemberPhonesV237 === "function") return legacyMemberPhonesV237(phone);
  const p = normalizePhone(phone || "");
  const out = [];
  if (p) out.push(p);
  if (p.length >= 8) out.push(p.slice(-8));
  if (p.length > 3 && p.startsWith("853")) out.push(p.slice(3));
  if (p.length === 8) out.push("853" + p);
  return Array.from(new Set(out.map(normalizePhone).filter(Boolean)));
}

function memberPurgeLastTokenV238(phone) {
  const p = normalizePhone(phone || "");
  if (!p) return "";
  if (p.length >= 8) return p.slice(-8);
  if (p.length > 3 && p.startsWith("853")) return p.slice(3);
  return p;
}

async function isPhonePurgedV238(env, phone) {
  const candidates = memberPurgeCandidatePhonesV238(phone);
  const last = memberPurgeLastTokenV238(phone);
  if (last) candidates.push("last8:" + last);
  for (const c of Array.from(new Set(candidates.filter(Boolean)))) {
    if (await env.ORDERS.get("member_purged:" + c)) return true;
  }
  return false;
}

async function isMemberPurgedRecordV238(env, member) {
  if (!member) return false;
  const phones = [];
  phones.push(member.phone);
  phones.push(member.memberPhone);
  phones.push(member.submittedPhone);
  if (member._kvKey) phones.push(String(member._kvKey).replace(/^member_deleted:|^member:/, ""));
  for (const phone of phones) {
    if (phone && await isPhonePurgedV238(env, phone)) return true;
  }
  return false;
}

async function writeMemberPurgeTombstoneV238(env, phone) {
  const now = new Date().toISOString();
  const candidates = memberPurgeCandidatePhonesV238(phone);
  const last = memberPurgeLastTokenV238(phone);
  const payload = JSON.stringify({ purgedAt: now, phoneLastToken: last, source: "telegram_permanent_delete", version: "V238" });
  const keys = new Set(candidates.map(c => "member_purged:" + c));
  if (last) keys.add("member_purged:last8:" + last);
  for (const key of keys) await env.ORDERS.put(key, payload);
  return { purgedAt: now, tombstones: Array.from(keys) };
}

async function collectMemberKeysForPhoneV238(env, phone) {
  const candidates = memberPurgeCandidatePhonesV238(phone);
  const wantedLast = memberPurgeLastTokenV238(phone);
  const out = new Set();

  for (const prefix of ["member:", "member_deleted:"]) {
    for (const c of candidates) out.add(prefix + c);
  }

  for (const prefix of ["member:", "member_deleted:"]) {
    let cursor = undefined;
    let checked = 0;
    do {
      const page = await env.ORDERS.list({ prefix, cursor });
      for (const key of (page.keys || [])) {
        checked += 1;
        if (checked > 10000) break;
        const keyPhone = normalizePhone(String(key.name || "").replace(prefix, ""));
        const keyLast = memberPurgeLastTokenV238(keyPhone);
        if (candidates.includes(keyPhone) || (wantedLast && keyLast === wantedLast)) out.add(key.name);
      }
      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor && checked <= 10000);
  }
  return Array.from(out);
}

async function collectOrderNosForPermanentDeleteV238(env, phone) {
  const candidates = memberPurgeCandidatePhonesV238(phone);
  const orderNos = new Set();
  for (const p of candidates) {
    for (const prefix of ["phone:" + p + ":", "member_ordered:" + p + ":", "member_deleted_order:" + p + ":"]) {
      let cursor = undefined;
      do {
        const page = await env.ORDERS.list({ prefix, cursor });
        for (const key of (page.keys || [])) {
          const rest = String(key.name || "").replace(prefix, "");
          const orderNo = rest.split(":")[0];
          if (orderNo) orderNos.add(orderNo);
        }
        cursor = page.cursor;
        if (page.list_complete !== false) break;
      } while (cursor);
    }
  }
  return Array.from(orderNos);
}

async function deletePrefixedKeysV238(env, prefixes) {
  let count = 0;
  for (const prefix of prefixes) {
    let cursor = undefined;
    do {
      const page = await env.ORDERS.list({ prefix, cursor });
      for (const key of (page.keys || [])) {
        await env.ORDERS.delete(key.name);
        count += 1;
      }
      cursor = page.cursor;
      if (page.list_complete !== false) break;
    } while (cursor);
  }
  return count;
}

async function permanentDeleteMemberV238(env, phone) {
  const candidates = memberPurgeCandidatePhonesV238(phone);
  const now = new Date().toISOString();
  const memberKeys = await collectMemberKeysForPhoneV238(env, phone);
  const orderNos = await collectOrderNosForPermanentDeleteV238(env, phone);
  let deletedMemberKeys = 0;
  let deletedOrderKeys = 0;
  let deletedIndexKeys = 0;
  let deletedArchiveKeys = 0;

  for (const key of memberKeys) {
    await env.ORDERS.delete(key);
    deletedMemberKeys += 1;
  }

  for (const orderNo of orderNos) {
    await env.ORDERS.delete("order:" + orderNo);
    deletedOrderKeys += 1;
    for (const p of candidates) {
      for (const key of [
        "phone:" + p + ":" + orderNo,
        "member_ordered:" + p + ":" + orderNo,
        "member_deleted_order:" + p + ":" + orderNo
      ]) {
        await env.ORDERS.delete(key);
        deletedIndexKeys += 1;
      }
    }
  }

  const archivePrefixes = [];
  for (const p of candidates) {
    archivePrefixes.push("member_deleted_order:" + p + ":");
    archivePrefixes.push("member_deleted_phone_index:" + p + ":");
    archivePrefixes.push("member_deleted_order_marker:" + p + ":");
  }
  deletedArchiveKeys += await deletePrefixedKeysV238(env, archivePrefixes);

  const tombstone = await writeMemberPurgeTombstoneV238(env, phone);
  return { purgedAt: now, deletedMemberKeys, deletedOrderKeys, deletedIndexKeys, deletedArchiveKeys, orderNos, tombstones: tombstone.tombstones };
}

const _oldListTelegramMembersV238 = listTelegramMembers;
listTelegramMembers = async function(env) {
  const members = await _oldListTelegramMembersV238(env);
  const filtered = [];
  for (const member of members) {
    if (!(await isMemberPurgedRecordV238(env, member))) filtered.push(member);
  }
  return filtered;
};

const _oldGetMemberForTelegramViewV238 = getMemberForTelegramView;
getMemberForTelegramView = async function(env, phone, deleted) {
  if (await isPhonePurgedV238(env, phone)) return null;
  const member = await _oldGetMemberForTelegramViewV238(env, phone, deleted);
  if (member && await isMemberPurgedRecordV238(env, member)) return null;
  return member;
};

buildMemberDetailReplyMarkup = function(member, deleted = false) {
  const phone = normalizePhone(member && member.phone);
  if (deleted) {
    return {
      inline_keyboard: [
        [{ text: "↩️ 恢復賬號", callback_data: "member_restore:" + phone }],
        [{ text: "🧨 永久刪除", callback_data: "member_purge:" + phone }],
        [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "🗑️ 刪除賬號", callback_data: "member_delete:" + phone }],
      [{ text: "🧨 永久刪除", callback_data: "member_purge:" + phone }],
      [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
    ]
  };
};

buildMemberReplyMarkup = function(member, deleted = false) {
  const phone = normalizePhone(member && member.phone);
  if (deleted) {
    return {
      inline_keyboard: [
        [{ text: "↩️ 撤回", callback_data: "member_restore:" + phone }],
        [{ text: "🧨 永久刪除", callback_data: "member_purge:" + phone }],
        [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "🗑️ 刪除", callback_data: "member_delete:" + phone }],
      [{ text: "🧨 永久刪除", callback_data: "member_purge:" + phone }],
      [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]
    ]
  };
};

const _oldHandleMemberActionV238 = handleMemberAction;
handleMemberAction = async function(env, cq, data) {
  try {
    const sep = data.indexOf(":");
    const action = sep >= 0 ? data.slice(0, sep) : "";
    const requestedPhone = normalizePhone(sep >= 0 ? data.slice(sep + 1) : "");
    const chatId = cq.message && cq.message.chat ? cq.message.chat.id : env.TELEGRAM_CHAT_ID;
    const messageId = cq.message ? cq.message.message_id : null;

    if (action === "member_purge") {
      if (!requestedPhone) return stop(env, cq, "找不到會員電話");
      const found = await findMemberRecordV237(env, requestedPhone, true);
      if (!found) {
        if (await isPhonePurgedV238(env, requestedPhone)) return stop(env, cq, "此會員已永久刪除");
        return stop(env, cq, "找不到會員資料");
      }
      const phone = normalizePhone(found.member.phone || requestedPhone);
      const text = [
        "⚠️ 永久刪除會員",
        "",
        "姓名：" + (found.member.name || "-"),
        "電話：" + (found.member.phone || phone || "-"),
        "",
        "目前狀態：" + (found.deleted ? "已刪除會員" : "有效會員"),
        "",
        "確認後會永久刪除此會員資料、舊 853 alias、已刪除備份及會員訂單索引。",
        "永久刪除後不會再於 Telegram 會員列表顯示，也不能按撤回恢復。"
      ].join("\n");
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [[
          { text: "✅ 確認永久刪除", callback_data: "member_purge_confirmed:" + phone },
          { text: "取消", callback_data: "member_purge_cancel:" + phone }
        ], [{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]]
      });
      return stop(env, cq, "請再次確認永久刪除");
    }

    if (action === "member_purge_cancel") {
      if (!requestedPhone) return stop(env, cq, "找不到會員電話");
      const found = await findMemberRecordV237(env, requestedPhone, true);
      if (!found) return stop(env, cq, "找不到會員資料");
      await editTelegramMessage(env, chatId, messageId, buildMemberTelegramText(found.member, !!found.deleted, false), buildMemberReplyMarkup(found.member, !!found.deleted));
      return stop(env, cq, "已取消永久刪除");
    }

    if (action === "member_purge_confirmed") {
      if (!requestedPhone) return stop(env, cq, "找不到會員電話");
      const result = await permanentDeleteMemberV238(env, requestedPhone);
      const members = await listTelegramMembers(env);
      const text = [
        "✅ 已永久刪除會員",
        "",
        "電話：" + requestedPhone,
        "刪除會員 key：" + result.deletedMemberKeys,
        "刪除訂單：" + result.deletedOrderKeys,
        "刪除索引/備份：" + (result.deletedIndexKeys + result.deletedArchiveKeys),
        "",
        "此會員已加入永久刪除記錄，之後不會再於 Telegram 會員列表顯示。"
      ].join("\n");
      await editTelegramMessage(env, chatId, messageId, text, { inline_keyboard: [[{ text: "📋 返回用戶列表", callback_data: "member_list:all" }]] });
      return stop(env, cq, "已永久刪除會員");
    }

    return _oldHandleMemberActionV238(env, cq, data);
  } catch (e) {
    try { return stop(env, cq, "操作失敗：" + (e.message || "未知錯誤")); }
    catch (_) { return json({ ok: false, error: e.message || "member permanent delete failed" }, 500); }
  }
};
