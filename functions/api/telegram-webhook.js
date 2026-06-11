
export async function onRequestPost(context) {
  const { request, env } = context;
  const update = await request.json();
  const cq = update.callback_query;
  if (!cq) return json({ ok:true });

  const data = cq.data || "";
  const [action, orderNo] = data.split(":");
  if (!orderNo || !["complete","pickup"].includes(action)) return json({ ok:true });

  const raw = await env.ORDERS.get("order:" + orderNo);
  if (!raw) { await answer(env, cq.id, "找不到訂單"); return json({ ok:true }); }
  const order = JSON.parse(raw);

  if (action === "complete") {
    order.status = "completed";
    order.completedAt = new Date().toISOString();
  } else {
    order.status = "picked_up";
    order.pickedUpAt = new Date().toISOString();
  }
  await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl:60*60*24*14 });

  const text = buildText(order);
  const markup = action==="complete" ? { inline_keyboard:[[ {text:"☕ 已領取 #"+orderNo, callback_data:"pickup:"+orderNo} ]]} : undefined;
  await edit(env, cq.message.chat.id, cq.message.message_id, text, markup);
  await answer(env, cq.id, action==="complete" ? "已標記完成 #"+orderNo : "已標記領取 #"+orderNo);
  return json({ ok:true });
}
function buildText(order){
  let base = String(order.orderText || "").trim();
  if (!base) {
    const lines=["☕ SKY31 ORDER","","訂單號：#"+order.orderNo,"取餐時間："+(order.pickupTime||""),""];
    (order.cart||[]).forEach(i=>{
      lines.push("☕ "+(i.name||i.cn||"-")+" ×"+(i.qty||1));
      const d=[i.cn&&i.cn!==i.name?i.cn:"",i.bean,i.flavor?"風味："+i.flavor:"",i.temp,i.ice&&i.ice!=="不適用"?i.ice:"",i.milk,i.pickup,i.note&&i.note!=="無備註"?"備註："+i.note:""].filter(Boolean);
      if(d.length) lines.push(d.join("｜"));
      lines.push("");
    });
    lines.push("客人："+(order.customerName||""),"電話："+(order.phone||""));
    base=lines.join("\n").trim();
  }
  const extra=["","━━━━━━━━━━━━━━"];
  if(order.completedAt){extra.push("✅ 狀態：已完成","完成時間："+fmt(new Date(order.completedAt)));}
  if(order.pickedUpAt){extra.push("☕ 狀態：已領取","領取時間："+fmt(new Date(order.pickedUpAt)));}
  if(order.status==="completed") extra.push("客人查詢頁：5分鐘後會顯示為已領取。");
  return base + "\n" + extra.join("\n");
}
async function answer(env,id,text){await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/answerCallbackQuery",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({callback_query_id:id,text})})}
async function edit(env,chat_id,message_id,text,reply_markup){const body={chat_id,message_id,text}; if(reply_markup) body.reply_markup=reply_markup; await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/editMessageText",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})}
function pad2(n){return String(n).padStart(2,"0")}
function fmt(d){return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate())+" "+pad2(d.getHours())+":"+pad2(d.getMinutes())}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8"}})}
