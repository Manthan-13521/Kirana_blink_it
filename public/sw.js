const CACHE = 'kirana-public-v1'
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE)
  await cache.addAll(['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'])
  await self.skipWaiting()
})()))
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys()
  await Promise.all(names.filter(name => name.startsWith('kirana-public-') && name !== CACHE).map(name => caches.delete(name)))
  await self.clients.claim()
})()))
self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')))
  } else if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/catalog/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) await cache.put(request, response.clone())
      return response
    })())
  }
})
self.addEventListener('push', event => event.waitUntil(self.registration.showNotification('Kirana order update', {body: 'Open the store to view your update.', icon:'/icon-192.png'})))
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(self.clients.openWindow('/'))
})
