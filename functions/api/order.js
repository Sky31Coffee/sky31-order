
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    const customerName = String(body.customerName || body.name || "").trim();
    const phone = String(body.phone || "").trim();
    if (!customerName || !phone) return json({ ok:false, error:"請輸入姓名和手機號碼" }, 400);

    const cart = normalizeCart(Array.isArray(body.cart) ? body.cart : []);
    if (!cart.length && !String(body.orderText || "").trim()) return json({ ok:false, error:"請先選擇飲品" }, 400);

    const orderNo = await nextOrderNo(env);
    const createdAt = new Date();
    const pickup = body.pickup || cart[0]?.pickup || "Now 即取";
    const pickupTime = resolvePickupTime(pickup, createdAt);

    let orderText = String(body.orderText || "").trim();
    if (!orderText) orderText = makeOrderText(orderNo, customerName, phone, pickupTime, cart);
    orderText = orderText.replaceAll("{ORDER_NO}", "#" + orderNo);
    if (!orderText.includes("#" + orderNo)) orderText = "訂單號：#" + orderNo + "\n" + orderText;

    const order = {
      orderNo, status:"pending", customerName, phone, pickup, pickupTime, cart, orderText,
      createdAt: createdAt.toISOString(), completedAt:null, pickedUpAt:null, telegramMessageId:null, telegramOk:false
    };
    const ttl = 60 * 60 * 24 * 14;
    await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
    await env.ORDERS.put("phone:" + normalizePhone(phone) + ":" + orderNo, orderNo, { expirationTtl: ttl });

    const task = sendTelegram(env, orderText, orderNo).then(async tg => {
      if (tg?.ok && tg.result?.message_id) {
        order.telegramOk = true;
        order.telegramMessageId = tg.result.message_id;
        await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
      }
    }).catch(async e => {
      order.telegramError = e.message || "Telegram failed";
      await env.ORDERS.put("order:" + orderNo, JSON.stringify(order), { expirationTtl: ttl });
    });

    if (context.waitUntil) context.waitUntil(task);
    else await Promise.race([task, delay(2500)]);

    return json({ ok:true, orderNo, status:order.status, pickupTime });
  } catch(e) {
    return json({ ok:false, error:e.message || "提交失敗，請稍後再試" }, 500);
  }
}
async function nextOrderNo(env) {
  const d = new Date();
  const key = "counter:" + d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate());
  const current = parseInt(await env.ORDERS.get(key) || "0", 10);
  const next = current + 1;
  await env.ORDERS.put(key, String(next), { expirationTtl: 60*60*24*30 });
  return "A" + String(next).padStart(3, "0");
}
function normalizeCart(cart){return cart.map(i=>({
  name:i.name||i.title||"", cn:i.cn||i.zh||"", qty:Number(i.qty||i.quantity||1), image:i.image||"",
  bean:i.bean||"", flavor:i.flavor||"", temp:i.temp||i.temperature||"", ice:i.ice||"",
  milk:i.milk||"", pickup:i.pickup||"", note:i.note||""
}))}
function makeOrderText(orderNo,name,phone,pickupTime,cart){
  const lines=["☕ SKY31 ORDER","","訂單號：#"+orderNo,"取餐時間："+pickupTime,""];
  cart.forEach(i=>{
    lines.push("☕ "+(i.name||i.cn||"-")+" ×"+(i.qty||1));
    const d=[i.cn&&i.cn!==i.name?i.cn:"",i.bean,i.flavor?"風味："+i.flavor:"",i.temp,i.ice&&i.ice!=="不適用"?i.ice:"",i.milk,i.pickup,i.note&&i.note!=="無備註"?"備註："+i.note:""].filter(Boolean);
    if(d.length) lines.push(d.join("｜"));
    lines.push("");
  });
  lines.push("客人："+name,"電話："+phone);
  return lines.join("\n").trim();
}
function resolvePickupTime(label, now){
  const d=new Date(now.getTime()); let slot="";
  label=label||"Now 即取";
  if(label.includes("明天早上")){d.setDate(now.getDate()+1);slot="08:30-09:00"}
  else if(label.includes("明天中午")){d.setDate(now.getDate()+1);slot="13:00-13:30"}
  else if(label.includes("30")){d.setMinutes(now.getMinutes()+30);slot=pad2(d.getHours())+":"+pad2(d.getMinutes());label="30分鐘後"}
  else {slot="ASAP";label="即取"}
  return formatDateOnly(d)+" "+slot+"（"+label+"）";
}
async function sendTelegram(env,text,orderNo){
  const token=env.TELEGRAM_BOT_TOKEN, chatId=env.TELEGRAM_CHAT_ID;
  if(!token||!chatId) throw new Error("Telegram env vars missing");
  const res=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text,reply_markup:{inline_keyboard:[[{text:"✅ 完成訂單 #"+orderNo,callback_data:"complete:"+orderNo}]]}})
  });
  return res.json();
}
function normalizePhone(p){return String(p||"").replace(/\D/g,"")}
function pad2(n){return String(n).padStart(2,"0")}
function formatDateOnly(d){return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate())}
function delay(ms){return new Promise(r=>setTimeout(r,ms))}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
