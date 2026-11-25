export function onRequest({ request, env }) {
  if (!env.KIRANA_API) return new Response('Store API is unavailable.',{status:503})
  return env.KIRANA_API.fetch(request)
}
