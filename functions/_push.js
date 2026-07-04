// Sky31 Web Push helpers
// V301: lightweight pickup-ready notifications. Uses D1-only env.ORDERS store.

const DEFAULT_VAPID_PUBLIC_KEY = "BH6_njul0KgPix_FVFwoLh1Si87hWlINKA4FuFBM-uXJO68zj_ln7A2nsfi8wTwzQhjDAmQSygeH12cnk8iZsbc";
const DEFAULT_VAPID_PRIVATE_KEY = "kKSXGlZlIDiUbc2cryMiU6Nu0wmhvXU5Ssthm3MOYDI";
const DEFAULT_VAPID_SUBJECT = "mailto:sky31@example.com";

export function getVapidPublicKey(env) {
  return String((env && env.VAPID_PUBLIC_KEY) || DEFAULT_VAPID_PUBLIC_KEY).trim();
}

function getVapidPrivateKey(env) {
  return String((env && env.VAPID_PRIVATE_KEY) || DEFAULT_VAPID_PRIVATE_KEY).trim();
}

function getVapidSubject(env) {
  return String((env && env.VAPID_SUBJECT) || DEFAULT_VAPID_SUBJECT).trim();
}

export function webPushStatus(env) {
  return {
    enabled: !!(getVapidPublicKey(env) && getVapidPrivateKey(env)),
    publicKey: getVapidPublicKey(env),
    subject: getVapidSubject(env),
    mode: (env && env.VAPID_PRIVATE_KEY) ? "ENV_VAPID" : "BUILT_IN_TEST_VAPID"
  };
}

export async function savePushSubscriptionV301(env, phone, subscription, meta = {}) {
  phone = normalizePhone(phone);
  if (!phone) throw new Error("missing phone");
  if (!subscription || !subscription.endpoint) throw new Error("missing subscription endpoint");
  const endpointHash = await shortHash(subscription.endpoint);
  const now = new Date().toISOString();
  const record = {
    type: "push_subscription",
    phone,
    name: String(meta.name || "").trim(),
    endpointHash,
    endpoint: subscription.endpoint,
    subscription,
    userAgent: String(meta.userAgent || "").slice(0, 300),
    platform: String(meta.platform || "").slice(0, 80),
    createdAt: meta.createdAt || now,
    updatedAt: now,
    enabled: true,
    version: "v301"
  };
  await env.ORDERS.put(pushKey(phone, endpointHash), JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 3650 });
  await env.ORDERS.put("push_endpoint:" + endpointHash, JSON.stringify({ phone, key: pushKey(phone, endpointHash), updatedAt: now }), { expirationTtl: 60 * 60 * 24 * 3650 });
  return { ok: true, phone, endpointHash, key: pushKey(phone, endpointHash) };
}

export async function sendOrderReadyPushV301(env, order) {
  const phone = normalizePhone(order && (order.phone || order.memberPhone || order.customerPhone));
  if (!phone || !env || !env.ORDERS) return { ok: false, sent: 0, reason: "missing phone/store" };
  const subs = await listPushSubscriptionsForPhone(env, phone);
  if (!subs.length) return { ok: true, sent: 0, reason: "no subscriptions" };

  let sent = 0;
  let failed = 0;
  const staleKeys = [];
  await Promise.all(subs.map(async rec => {
    try {
      const res = await sendRawPushNoPayload(env, rec.subscription || rec);
      if (res && (res.status === 404 || res.status === 410)) {
        failed += 1;
        staleKeys.push(rec.__key);
      } else if (res && res.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (_) {
      failed += 1;
    }
  }));
  await Promise.all(staleKeys.filter(Boolean).map(k => env.ORDERS.delete(k).catch(() => {})));
  return { ok: true, sent, failed, staleRemoved: staleKeys.length };
}

export async function sendTestPushToPhoneV301(env, phone) {
  phone = normalizePhone(phone);
  const subs = await listPushSubscriptionsForPhone(env, phone);
  let sent = 0;
  let failed = 0;
  for (const rec of subs) {
    try {
      const res = await sendRawPushNoPayload(env, rec.subscription || rec);
      if (res && res.ok) sent += 1; else failed += 1;
    } catch (_) { failed += 1; }
  }
  return { ok: true, phone, subscriptions: subs.length, sent, failed };
}

async function listPushSubscriptionsForPhone(env, phone) {
  phone = normalizePhone(phone);
  const out = [];
  let cursor;
  do {
    const page = await env.ORDERS.list({ prefix: "push:" + phone + ":", cursor, limit: 1000 });
    const keys = Array.isArray(page && page.keys) ? page.keys : [];
    for (const item of keys) {
      const key = item && item.name;
      if (!key) continue;
      try {
        const raw = await env.ORDERS.get(key);
        if (!raw) continue;
        const rec = JSON.parse(raw);
        if (rec && rec.enabled !== false && rec.endpoint && rec.subscription) {
          rec.__key = key;
          out.push(rec);
        }
      } catch (_) {}
    }
    cursor = page && page.cursor;
    if (page && page.list_complete !== false) break;
  } while (cursor);
  return out;
}

async function sendRawPushNoPayload(env, subscription) {
  if (!subscription || !subscription.endpoint) throw new Error("missing endpoint");
  const endpoint = String(subscription.endpoint);
  const aud = new URL(endpoint).origin;
  const jwt = await createVapidJWT(env, aud);
  const publicKey = getVapidPublicKey(env);
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "TTL": "300",
      "Urgency": "high",
      "Authorization": "vapid t=" + jwt + ", k=" + publicKey,
      "Content-Length": "0"
    }
  });
}

async function createVapidJWT(env, audience) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: getVapidSubject(env)
  };
  const signingInput = base64UrlJson(header) + "." + base64UrlJson(payload);
  const key = await importVapidPrivateKey(env);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return signingInput + "." + base64UrlEncode(new Uint8Array(sig));
}

async function importVapidPrivateKey(env) {
  const publicRaw = base64UrlDecode(getVapidPublicKey(env));
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error("invalid VAPID public key");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicRaw.slice(1, 33)),
    y: base64UrlEncode(publicRaw.slice(33, 65)),
    d: getVapidPrivateKey(env),
    ext: true
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function pushKey(phone, endpointHash) {
  return "push:" + normalizePhone(phone) + ":" + endpointHash;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

async function shortHash(value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return base64UrlEncode(new Uint8Array(buf)).slice(0, 32);
}

function base64UrlJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function base64UrlEncode(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(str) {
  str = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
