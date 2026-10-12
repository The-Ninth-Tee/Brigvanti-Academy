/* Push reminders. Loaded by sw.js through importScripts('/push-sw.js'). */
self.addEventListener('push', function (event) {
  let d = {};
  try {
    const p = event.data ? event.data.json() : {};
    d = p.notification || p.data || p;
  } catch (e) {
    d = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(d.title || 'Brigvanti', {
    body: d.body || '',
    icon: '/Icons/app-icon-192.png',
    tag: d.tag || 'brigvanti-reminder',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        return c.navigate ? c.navigate(url).then(function (w) { return (w || c).focus(); }) : c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
