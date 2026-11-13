import type { ErpEnv } from './types';

async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

export type AuthResult = 'ok' | 'unconfigured' | 'denied';

/**
 * Validasi API key dari header `Authorization: Bearer <key>` atau `X-API-KEY`.
 * - 'unconfigured' : secret WORKER_API_KEY belum diset di Worker (fail-closed untuk rute ERP).
 * - Perbandingan dilakukan lewat hash SHA-256 supaya waktu eksekusinya konstan.
 */
export async function authorize(request: Request, env: ErpEnv): Promise<AuthResult> {
  const expected = env.WORKER_API_KEY;
  if (!expected) return 'unconfigured';

  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const provided = (request.headers.get('X-API-KEY') || '').trim() || bearer;
  if (!provided) return 'denied';

  const [a, b] = await Promise.all([sha256Bytes(provided), sha256Bytes(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 ? 'ok' : 'denied';
}
