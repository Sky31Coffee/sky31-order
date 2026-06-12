export async function onRequestPost(context) {
  const { request, env } = context;
  const update = await request.json();

  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || "";

    if (data.startsWith("complete:")) {
      const orderNo = data.split(":")[1];
      const order = await getOrder(env, orderNo, cq);
      if (!order) return json({ ok: true });

      if (order.status === "cancelled") {
        await answerCallback(env, cq.id, "此訂單已取消，請先恢復訂單");
        return json({ ok: true });
      }

      order.status = "completed";
      order.completedAt = new Date().toISOString();
      order.pickedUpAt = null;

      clearCancelBackup(order);

      await saveOrder(env, order);
      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order), buildReplyMarkup(order));
      await answerCallback(env, cq.id, "已完成 #" + order.orderNo);
    }

    if (data.startsWith("pickup:")) {
      const orderNo = data.split(":")[1];
      const order = await getOrder(env, orderNo, cq);
      if (!order) return json({ ok: true });

      if (order.status === "cancelled") {
        await answerCallback(env, cq.id, "此訂單已取消，請先恢復訂單");
        return json({ ok: true });
      }

      order.status = "picked_up";
      if (!order.completedAt) order.completedAt = new Date().toISOString();
      order.pickedUpAt = new Date().toISOString();

      clearCancelBackup(order);

      await saveOrder(env, order);
      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order), buildReplyMarkup(order));
      await answerCallback(env, cq.id, "已領取 #" + order.orderNo);
    }

    if (data.startsWith("undo_pickup:")) {
      const orderNo = data.split(":")[1];
      const order = await getOrder(env, orderNo, cq);
      if (!order) return json({ ok: true });

      if (order.status === "cancelled") {
        await answerCallback(env, cq.id, "此訂單已取消，請先恢復訂單");
        return json({ ok: true });
      }

      if (order.status !== "picked_up") {
        await answerCallback(env, cq.id, "目前不是已領取狀態");
        return json({ ok: true });
      }

      order.status = "completed";
      order.pickedUpAt = null;
      if (!order.completedAt) order.completedAt = new Date().toISOString();

      await saveOrder(env, order);
      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order), buildReplyMarkup(order));
      await answerCallback(env, cq.id, "已撤回領取 #" + order.orderNo);
    }

    if (data.startsWith("undo_complete:")) {
      const orderNo = data.split(":")[1];
      const order = await getOrder(env, orderNo, cq);
      if (!order) return json({ ok: true });

      if (order.status === "cancelled") {
        await answerCallback(env, cq.id, "此訂單已取消，請先恢復訂單");
        return json({ ok: true });
      }

      if (order.status === "picked_up") {
        await answerCallback(env, cq.id, "請先撤回領取，再撤回完成");
        return json({ ok: true });
      }

      if (order.status !== "completed") {
        await answerCallback(env, cq.id, "目前不是已完成狀態");
        return json({ ok: true });
      }

      order.status = "pending";
      order.completedAt = null;
      order.pickedUpAt = null;

      await saveOrder(env, order);
      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order), buildReplyMarkup(order));
      await answerCallback(env, cq.id, "已撤回完成 #" + order.orderNo);
    }

    if (data.startsWith("cancel:")) {
      const orderNo = data.split(":")[1];
      const order = await getOrder(env, orderNo, cq);
      if (!order) return json({ ok: true });

      if (order.status === "cancelled") {
        await answerCallback(env, cq.id, "此訂單已經取消");
        return json({ ok: true });
      }

      order.statusBeforeCancel = order.status || "pending";
      order.completedAtBeforeCancel = order.completedAt || null;
      order.pickedUpAtBeforeCancel = order.pickedUpAt || null;

      order.status = "cancelled";
      order.cancelledAt = new Date().toISOString();

      await saveOrder(env, order);
      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order), buildReplyMarkup(order));
      await answerCallback(env, cq.id, "已取消 #" + order.orderNo);
    }

    if (data.startsWith("restore:")) {
      const orderNo = data.split(":")[1];
      const order = await getOrder(env, orderNo, cq);
      if (!order) return json({ ok: true });

      if (order.status !== "cancelled") {
        await answerCallback(env, cq.id, "目前不是已取消狀態");
        return json({ ok: true });
      }

      const restoreStatus = normalizeStatus(order.statusBeforeCancel || "pending");

      order.status = restoreStatus;
      order.restoredAt = new Date().toISOString();

      if (restoreStatus === "pending") {
        order.completedAt = null;
        order.pickedUpAt = null;
      }

      if (restoreStatus === "completed") {
        order.completedAt = order.completedAtBeforeCancel || order.completedAt || new Date().toISOString();
        order.pickedUpAt = null;
      }

      if (restoreStatus === "picked_up") {
        order.completedAt = order.completedAtBeforeCancel || order.completedAt || new Date().toISOString();
        order.pickedUpAt = order.pickedUpAtBeforeCancel || order.pickedUpAt || new Date().toISOString();
      }

      order.cancelledAt = null;
      clearCancelBackup(order);

      await saveOrder(env, order);
      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order), buildReplyMarkup(order));
      await answerCallback(env, cq.id, "已恢復 #" + order.orderNo);
    }
  }

  return json({ ok: true });
}

async function getOrder(env, orderNo, cq) {
  const raw = await env.ORDERS.get("order:" + orderNo);
  if (!raw) {
    await answerCallback(env, cq.id, "找不到訂單");
    return null;
  }
  return JSON.parse(raw);
}

async function saveOrder(env, order) {
  await env.ORDERS.put("order:" + order.orderNo, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 14 });
}

function normalizeStatus(status) {
  if (status === "completed") return "completed";
  if (status === "picked_up") return "picked_up";
  if (status === "cancelled") return "pending";
  return "pending";
}

function clearCancelBackup(order) {
  order.statusBeforeCancel = null;
  order.completedAtBeforeCancel = null;
  order.pickedUpAtBeforeCancel = null;
}

function buildReplyMarkup(order) {
  const orderNo = order.orderNo || "";
  const status = order.status || "pending";

  if (status === "cancelled") {
    return {
      inline_keyboard: [[
        { text: "↩️ 恢復訂單 #" + orderNo, callback_data: "restore:" + orderNo }
      ]]
    };
  }

  if (status === "picked_up") {
    return {
      inline_keyboard: [[
        { text: "↩️ 撤回領取 #" + orderNo, callback_data: "undo_pickup:" + orderNo }
      ]]
    };
  }

  if (status === "completed") {
    return {
      inline_keyboard: [
        [
          { text: "☕ 已領取 #" + orderNo, callback_data: "pickup:" + orderNo },
          { text: "↩️ 撤回完成 #" + orderNo, callback_data: "undo_complete:" + orderNo }
        ],
        [
          { text: "❌ 取消訂單 #" + orderNo, callback_data: "cancel:" + orderNo }
        ]
      ]
    };
  }

  return {
    inline_keyboard: [[
      { text: "✅ 完成訂單 #" + orderNo, callback_data: "complete:" + orderNo },
      { text: "❌ 取消訂單 #" + orderNo, callback_data: "cancel:" + orderNo }
    ]]
  };
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

  if (order.status === "pending" || !order.status) {
    lines.push("");
    lines.push("────────────");
    lines.push("🕐 狀態：等待製作");
  }

  if (order.status === "completed" || order.status === "picked_up") {
    lines.push("");
    lines.push("────────────");
    lines.push("✅ 狀態：已完成");
    if (order.completedAt) lines.push("完成時間：" + formatDateTime(order.completedAt));
  }

  if (order.status === "picked_up") {
    lines.push("☕ 狀態：已領取");
    if (order.pickedUpAt) lines.push("領取時間：" + formatDateTime(order.pickedUpAt));
  }

  if (order.status === "cancelled") {
    lines.push("");
    lines.push("────────────");
    lines.push("❌ 狀態：已取消");
    if (order.cancelledAt) lines.push("取消時間：" + formatDateTime(order.cancelledAt));
    if (order.statusBeforeCancel) lines.push("取消前狀態：" + statusLabel(order.statusBeforeCancel));
  }

  if (order.restoredAt && order.status !== "cancelled") {
    lines.push("");
    lines.push("↩️ 最近恢復：" + formatDateTime(order.restoredAt));
  }

  return lines.join("\n").trim();
}

function statusLabel(status) {
  if (status === "completed") return "已完成";
  if (status === "picked_up") return "已領取";
  if (status === "cancelled") return "已取消";
  return "等待製作";
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
  const url = "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/answerCallbackQuery";
  await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup) {
  const url = "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/editMessageText";
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
