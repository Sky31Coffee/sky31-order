const SKY31_SW_VERSION = 'v301-push';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  const title = 'Sky31 Coffee';
  let body = '你的訂單已完成，可以取餐了 ☕';
  try {
    if (event.data) {
      const text = event.data.text();
      if (text) body = text;
    }
  } catch (_) {}
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: 'sky31-order-ready',
    renotify: true,
    icon: '/apple-touch-icon.png',
    badge: '/favicon.png',
    data: { url: '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification && event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        try { await client.focus(); return; } catch (_) {}
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
