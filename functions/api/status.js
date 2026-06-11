
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const orderNo = (url.searchParams.get("orderNo") || "").trim().replace(/^#/, "").toUpperCase();
  const phone = normalizePhone(url.searchParams.get("phone") || "");
  if (!phone) return json({ ok:false, error:"請輸入手機號碼" }, 400);

  if (orderNo) {
    const raw = await env.ORDERS.get("order:" + orderNo);
    if (!raw) return json({ ok:false, error:"查詢不到此訂單號" }, 404);
    const order = JSON.parse(raw);
    if (normalizePhone(order.phone) !== phone) return json({ ok:false, error:"手機號碼不正確" }, 403);
    return json(formatOrder(order));
  }

  const listed = await env.ORDERS.list({ prefix:"phone:" + phone + ":" });
  if (!listed.keys?.length) return json({ ok:false, error:"查詢不到目前可顯示的訂單" }, 404);

  const orders = [];
  const nos = listed.keys.map(k=>k.name.split(":").pop()).filter(Boolean).sort().reverse();
  for (const no of nos) {
    if (orders.length >= 3) break;
    const raw = await env.ORDERS.get("order:" + no);
    if (!raw) continue;
    const order = JSON.parse(raw);
    if (!showInPhoneList(order)) continue;
    orders.push(formatOrder(order));
  }
  if (!orders.length) return json({ ok:false, error:"目前沒有製作中或近期已完成的訂單。如需查詢舊訂單，請輸入訂單號。" }, 404);
  return json({ ok:true, orders });
}
function showInPhoneList(order){
  if(!order || order.status==="picked_up") return false;
  if(order.status==="completed" && order.completedAt){
    const t=new Date(order.completedAt).getTime();
    return !t || Date.now()-t <= 60*60*1000;
  }
  return true;
}
function displayStatus(order){
  if(order.status==="completed" && order.completedAt){
    const t=new Date(order.completedAt).getTime();
    if(t && Date.now()-t >= 5*60*1000) return "picked_up";
  }
  return order.status || "pending";
}
function formatOrder(order){
  const cart = Array.isArray(order.cart) ? order.cart : [];
  return {
    ok:true, orderNo:order.orderNo, status:order.status||"pending", displayStatus:displayStatus(order),
    pickupTime:order.pickupTime||order.pickup||"", createdAt:order.createdAt||"", completedAt:order.completedAt||null,
    pickedUpAt:order.pickedUpAt||null, customerName:order.customerName||"", phone:order.phone||"",
    pickup:order.pickup||"", orderText:order.orderText||"",
    cart:cart.map(i=>({name:i.name||i.title||"",cn:i.cn||i.zh||"",qty:Number(i.qty||i.quantity||1),image:i.image||"",bean:i.bean||"",flavor:i.flavor||"",temp:i.temp||i.temperature||"",ice:i.ice||"",milk:i.milk||"",pickup:i.pickup||"",note:i.note||""}))
  };
}
function normalizePhone(p){return String(p||"").replace(/\D/g,"")}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
