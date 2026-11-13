// Entry point Worker: menambahkan login + 2FA di depan API yang sudah ada (src/index.ts).
// index.ts tidak diubah; semua endpoint selain health check kini wajib punya sesi login.
import app from './index';
import type { Env as BaseEnv } from './index';
import { authenticate, corsHeaders, handleAuthRoute, type AuthEnv } from './auth';

type Env = BaseEnv & AuthEnv;

// Hanya health check yang boleh diakses tanpa login
const PUBLIC_PATHS = new Set(['/', '/health', '/api/health']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const authResponse = await handleAuthRoute(request, env, pathname);
    if (authResponse) return authResponse;

    if (PUBLIC_PATHS.has(pathname)) return app.fetch(request, env);

    const session = await authenticate(request, env);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized. Silakan login terlebih dahulu.' }), {
        status: 401,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    return app.fetch(request, env);
  },
};
