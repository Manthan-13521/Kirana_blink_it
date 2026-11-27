let seen=false
export default {
  async fetch(request, env) {
    const missing = () => new Response('Not found', {status:404, headers:{'Cache-Control':'no-store'}})
    if (request.method!=='GET' || Date.now()>=Number(env.PROBE_UNTIL)) return missing()
    const path = new URL(request.url)
    const grant = request.headers.get('authorization') ?? ''
    if (!/^Bearer [a-f0-9]{64}$/.test(grant)) return missing()
    const proof = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(grant.slice(7)))
    if (new Uint8Array(proof).toHex() !== env.PROBE_SHA256) return missing()
    const first = !seen
    seen = true
    const start = performance.now()
    if (path.pathname==='/probe/single-d1') {
      const result = await env.DB.prepare('SELECT 1').all()
      return Response.json({primary:result.meta.served_by_primary??null,region:result.meta.served_by_region??null},{
        headers:{'Cache-Control':'no-store','Server-Timing':'single_d1;dur='+(performance.now()-start)+', single_sql;dur='+(result.meta.timings?.sql_duration_ms??0), 'X-Probe-First':String(first)}
      })
    }
    if (path.pathname!=='/api/health'&&path.pathname!=='/api/catalog'&&!/^[/]api[/]catalog[/]load-[0-9]{4}$/.test(path.pathname))return missing()
    const response = await env.API.fetch(request)
    const headers = new Headers(response.headers)
    headers.append('Server-Timing','pages_binding;dur='+(performance.now()-start))
    headers.set('X-Probe-First',String(first))
    headers.set('Cache-Control','no-store')
    return new Response(response.body,{status:response.status,headers})
  }
}
