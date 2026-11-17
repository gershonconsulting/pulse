// functions/api/health.js
// GET /api/health — simple health check
import { APP_VERSION } from '../_version.js';

export async function onRequestGet() {
  return new Response(JSON.stringify({
    status: 'ok',
    version: APP_VERSION,
    platform: 'cloudflare-pages',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
