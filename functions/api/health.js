// functions/api/health.js
// GET /api/health — simple health check

export async function onRequestGet() {
  return new Response(JSON.stringify({
    status: 'ok',
    version: '3.0.0',
    platform: 'cloudflare-pages',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
