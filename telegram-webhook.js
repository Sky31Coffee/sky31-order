
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
      await env.ORDERS.put("order:" + orderNo, JSON.stringify(order));

      const text =
        "✅ SKY31 ORDER 已完成\n\n" +
        "訂單號：#" + orderNo + "\n" +
        "完成時間：" + formatDateTime(new Date()) + "\n\n" +
        "客人：" + order.customerName + "\n" +
        "電話：" + order.phone + "\n\n" +
        "客人可於1小時內查詢到已完成狀態。";

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
      await env.ORDERS.put("order:" + orderNo, JSON.stringify(order));

      const text =
        "☕ SKY31 ORDER 已領取\n\n" +
        "訂單號：#" + orderNo + "\n" +
        "領取時間：" + formatDateTime(new Date()) + "\n\n" +
        "客人：" + order.customerName + "\n" +
        "電話：" + order.phone;

      await editTelegramMessage(env, cq.message.chat.id, cq.message.message_id, text);
      await answerCallback(env, cq.id, "已標記領取 #" + orderNo);
    }
  }

  return json({ ok: true });
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

function pad2(n) { return String(n).padStart(2, "0"); }
function formatDateOnly(d) { return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function formatDateTime(d) { return formatDateOnly(d)+" "+pad2(d.getHours())+":"+pad2(d.getMinutes()); }
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
