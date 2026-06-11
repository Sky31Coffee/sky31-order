
export async function onRequestPost(context) {
  const { request, env } = context;
  const update = await request.json();

  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || "";

    if (data.startsWith("complete:")) {
      const orderNo = data.split(":")[1];
      const raw = await env.ORDERS.get("order:" + orderNo);
      if (!raw) {
        await answerCallback(env, cq.id, "找不到訂單");
        return json({ ok: true });
      }

      const order = JSON.parse(raw);
      order.status = "completed";
      order.completedAt = new Date().toISOString();

      await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 14 });

      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order), {
        inline_keyboard: [[
          { text: "☕ 已領取 #" + orderNo, callback_data: "pickup:" + orderNo }
        ]]
      });

      await answerCallback(env, cq.id, "已完成 #" + orderNo);
    }

    if (data.startsWith("pickup:")) {
      const orderNo = data.split(":")[1];
      const raw = await env.ORDERS.get("order:" + orderNo);
      if (!raw) {
        await answerCallback(env, cq.id, "找不到訂單");
        return json({ ok: true });
      }

      const order = JSON.parse(raw);
      order.status = "picked_up";
      if (!order.completedAt) order.completedAt = new Date().toISOString();
      order.pickedUpAt = new Date().toISOString();

      await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 14 });

      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, buildTelegramText(order));
      await answerCallback(env, cq.id, "已領取 #" + orderNo);
    }
  }

  return json({ ok: true });
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
      if (item.bean) lines.push("🍫 " + item.bean);
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

  return lines.join("\n").trim();
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
