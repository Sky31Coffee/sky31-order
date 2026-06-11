
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

      const originalText = buildOriginalOrderText(order);
      const text =
        originalText +
        "\n\n━━━━━━━━━━━━━━" +
        "\n✅ 狀態：已完成" +
        "\n完成時間：" + formatDateTime(new Date()) +
        "\n\n客人查詢頁：5分鐘後會顯示為已領取。";

      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, text, {
        inline_keyboard: [[
          { text: "☕ 已領取 #" + orderNo, callback_data: "pickup:" + orderNo }
        ]]
      });

      await answerCallback(env, cq.id, "已標記完成 #" + orderNo);
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
      order.pickedUpAt = new Date().toISOString();
      await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 14 });

      const originalText = buildOriginalOrderText(order);
      const completedLine = order.completedAt ? "\n完成時間：" + formatDateTime(new Date(order.completedAt)) : "";
      const text =
        originalText +
        "\n\n━━━━━━━━━━━━━━" +
        "\n✅ 狀態：已完成" +
        completedLine +
        "\n☕ 狀態：已領取" +
        "\n領取時間：" + formatDateTime(new Date());

      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, text);
      await answerCallback(env, cq.id, "已標記領取 #" + orderNo);
    }
  }

  return json({ ok: true });
}

function buildOriginalOrderText(order) {
  if (order.orderText && String(order.orderText).trim()) {
    return String(order.orderText).trim();
  }

  const lines = [];
  lines.push("☕ SKY31 ORDER");
  lines.push("");
  lines.push("訂單號：#" + (order.orderNo || ""));
  if (order.pickupTime) lines.push("取餐時間：" + order.pickupTime);
  lines.push("");

  if (Array.isArray(order.cart) && order.cart.length) {
    order.cart.forEach(item => {
      const title = item.name || item.cn || "-";
      const qty = item.qty || 1;
      lines.push("☕ " + title + " ×" + qty);

      const details = [];
      if (item.bean) details.push(item.bean);
      if (item.flavor) details.push("風味：" + item.flavor);
      if (item.temp) details.push(item.temp);
      if (item.ice && item.ice !== "不適用") details.push(item.ice);
      if (item.milk) details.push(item.milk);
      if (item.note && item.note !== "無備註") details.push("備註：" + item.note);
      if (details.length) lines.push(details.join("｜"));
    });
    lines.push("");
  }

  lines.push("客人：" + (order.customerName || ""));
  lines.push("電話：" + (order.phone || ""));
  return lines.join("\n");
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
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text
  };
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
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function formatDateTime(d) {
  return formatDateOnly(d) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
