const CACHE = 'kirana-public-v3'
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE)
  await cache.addAll(['/offline.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'])
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
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const fallback = await caches.match('/offline.html')
      if (!fallback) return new Response('The store is offline.', {status:503})
      return new Response(fallback.body, {headers: fallback.headers, status: fallback.status})
    }))
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
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({type:'window',includeUncontrolled:true})
    const store = pages.find(page => new URL(page.url).origin === self.location.origin)
    if (store) await store.focus()
    else await self.clients.openWindow('/')
  })())
})
