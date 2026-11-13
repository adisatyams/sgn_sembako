// Autentikasi ERP SGN Sembako: email + password, lalu 2FA kode 6 digit via email.
// Semua data auth disimpan di Cloudflare D1 (tabel auth_*). Password TIDAK pernah disimpan
// polos: hanya hash PBKDF2-SHA256 dengan salt acak. Kode 2FA dan token sesi juga hanya
// disimpan dalam bentuk hash.

export interface AuthEnv {
  DB?: any; // Cloudflare D1
  ADMIN_EMAIL?: string; // default: adi.satya.ms@gmail.com
  ADMIN_INITIAL_PASSWORD?: string; // secret, dipakai SEKALI untuk membuat akun saat login pertama
  EMAIL?: any; // binding Cloudflare Email Service (send_email), dipakai lebih dulu bila ada
  RESEND_API_KEY?: string; // cadangan: kirim lewat Resend bila binding EMAIL tidak ada
  MAIL_FROM?: string; // alamat pengirim di domain Anda, contoh: login@domainanda.com
  AUTH_PEPPER?: string; // secret opsional, tambahan pengaman hash kode 2FA
}

const DEFAULT_ADMIN_EMAIL = 'adi.satya.ms@gmail.com';

const PBKDF2_ITERATIONS = 100_000; // batas maksimum PBKDF2 di Cloudflare Workers
const OTP_TTL_MS = 5 * 60 * 1000; // kode 2FA berlaku 5 menit
const OTP_MAX_ATTEMPTS = 5; // salah kode maksimal 5x per tantangan
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // kirim ulang minimal tiap 60 detik
const OTP_MAX_RESENDS = 5;
const LOGIN_MAX_FAILS = 5; // salah password 5x -> dikunci
const LOGIN_LOCK_MS = 15 * 60 * 1000; // kunci 15 menit
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sesi 7 hari
const MIN_PASSWORD_LENGTH = 10;

const DUMMY_SALT = '00112233445566778899aabbccddeeff';
const enc = new TextEncoder();

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-KEY, Accept',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

// ---------- util kripto ----------

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hashPassword(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations },
    key,
    256
  );
  return toHex(bits);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 6 digit acak yang seragam (tanpa modulo bias)
function randomOtp(): string {
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % 1_000_000).padStart(6, '0');
}

async function hashOtp(env: AuthEnv, challengeId: string, code: string): Promise<string> {
  return sha256Hex(`${challengeId}:${code}:${env.AUTH_PEPPER || ''}`);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local[local.length - 1]}`;
  return `${masked}@${domain}`;
}

function adminEmail(env: AuthEnv): string {
  return (env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).trim().toLowerCase();
}

function validateNewPassword(password: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password baru minimal ${MIN_PASSWORD_LENGTH} karakter.`;
  if (password.length > 128) return 'Password terlalu panjang (maksimal 128 karakter).';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password harus mengandung huruf dan angka.';
  if (password.toLowerCase() === email.toLowerCase()) return 'Password tidak boleh sama dengan email.';
  return null;
}

// ---------- skema D1 ----------

let schemaReady = false;

async function ensureSchema(db: any): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      iterations INTEGER NOT NULL,
      failed_count INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      resends INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`),
  ]);
  schemaReady = true;
}

// ---------- pengguna ----------

async function findUser(env: AuthEnv, email: string): Promise<any | null> {
  return (await env.DB.prepare('SELECT * FROM auth_users WHERE email = ?1').bind(email).first()) || null;
}

// Akun admin dibuat otomatis dari secret ADMIN_INITIAL_PASSWORD saat login pertama.
// Setelah akun ada, secret itu tidak dipakai lagi (password aktif = yang ada di D1).
async function findOrSeedUser(env: AuthEnv, email: string): Promise<any | null> {
  const existing = await findUser(env, email);
  if (existing) return existing;
  if (email !== adminEmail(env) || !env.ADMIN_INITIAL_PASSWORD) return null;

  const salt = randomHex(16);
  const hash = await hashPassword(env.ADMIN_INITIAL_PASSWORD, salt, PBKDF2_ITERATIONS);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO auth_users (id, email, password_hash, password_salt, iterations, failed_count, locked_until, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?6)`
  )
    .bind(crypto.randomUUID(), email, hash, salt, PBKDF2_ITERATIONS, now)
    .run();
  return findUser(env, email);
}

// ---------- email 2FA ----------

async function sendOtpEmail(env: AuthEnv, to: string, code: string): Promise<void> {
  const minutes = Math.round(OTP_TTL_MS / 60000);
  const subject = 'Kode verifikasi login SGN Sembako';
  const text =
    `Kode verifikasi login SGN Sembako Anda: ${code}\n\n` +
    `Kode berlaku ${minutes} menit. Jangan bagikan kode ini kepada siapa pun.\n` +
    `Jika Anda tidak sedang mencoba login, abaikan email ini dan segera ganti password Anda.`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">` +
    `<h2 style="margin:0 0 12px">Verifikasi Login</h2>` +
    `<p style="color:#444">Masukkan kode berikut untuk menyelesaikan login ke SGN Sembako:</p>` +
    `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;background:#f3f4f6;padding:16px;text-align:center;border-radius:8px">${code}</p>` +
    `<p style="color:#444">Kode berlaku ${minutes} menit. Jangan bagikan kode ini kepada siapa pun.</p>` +
    `<p style="color:#888;font-size:12px">Jika Anda tidak sedang mencoba login, abaikan email ini dan segera ganti password Anda.</p>` +
    `</div>`;

  // 1) Cloudflare Email Service (binding EMAIL) - tanpa layanan pihak ketiga
  if (env.EMAIL?.send) {
    if (!env.MAIL_FROM) throw new Error('EMAIL_NOT_CONFIGURED MAIL_FROM kosong');
    await env.EMAIL.send({ to, from: env.MAIL_FROM, subject, html, text });
    return;
  }

  // 2) Cadangan: Resend
  if (!env.RESEND_API_KEY) throw new Error('EMAIL_NOT_CONFIGURED');
  const from = env.MAIL_FROM || 'SGN Sembako <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`EMAIL_SEND_FAILED ${res.status} ${detail.slice(0, 200)}`);
  }
}

function emailErrorResponse(err: any): Response {
  const msg = String(err?.message || '');
  console.error('2FA email error:', msg);
  if (msg.startsWith('EMAIL_NOT_CONFIGURED')) {
    return json({ error: 'Pengiriman email belum dikonfigurasi di Worker (binding EMAIL + MAIL_FROM, atau secret RESEND_API_KEY, belum diisi).' }, 503);
  }
  return json({ error: 'Gagal mengirim email kode verifikasi. Coba lagi beberapa saat.' }, 502);
}

// ---------- sesi ----------

async function createSession(env: AuthEnv, userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomHex(32);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?1').bind(now).run();
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256Hex(token), userId, expiresAt, now)
    .run();
  return { token, expiresAt };
}

export interface AuthSession {
  userId: string;
  email: string;
  tokenHash: string;
}

export async function authenticate(request: Request, env: AuthEnv): Promise<AuthSession | null> {
  if (!env.DB) return null;
  await ensureSchema(env.DB);
  const match = /^Bearer\s+([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!match) return null;
  const tokenHash = await sha256Hex(match[1]);
  const row = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email
     FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`
  )
    .bind(tokenHash, Date.now())
    .first();
  return row ? { userId: row.id, email: row.email, tokenHash } : null;
}

// ---------- handler ----------

async function readJson(request: Request): Promise<Record<string, any>> {
  const body = await request.json().catch(() => ({}));
  return body && typeof body === 'object' ? (body as Record<string, any>) : {};
}

async function issueChallenge(env: AuthEnv, user: any): Promise<Response> {
  const now = Date.now();
  const challengeId = randomHex(16);
  const code = randomOtp();
  await env.DB.prepare('DELETE FROM auth_challenges WHERE user_id = ?1').bind(user.id).run();
  await env.DB.prepare(
    'INSERT INTO auth_challenges (id, user_id, code_hash, expires_at, attempts, resends, created_at) VALUES (?1, ?2, ?3, ?4, 0, 0, ?5)'
  )
    .bind(challengeId, user.id, await hashOtp(env, challengeId, code), now + OTP_TTL_MS, now)
    .run();
  try {
    await sendOtpEmail(env, user.email, code);
  } catch (err) {
    await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?1').bind(challengeId).run();
    return emailErrorResponse(err);
  }
  return json({
    ok: true,
    challengeId,
    email: maskEmail(user.email),
    expiresInSec: Math.round(OTP_TTL_MS / 1000),
    resendAfterSec: Math.round(OTP_RESEND_COOLDOWN_MS / 1000),
  });
}

async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password || password.length > 256) {
    return json({ error: 'Email dan password wajib diisi.' }, 400);
  }

  const user = await findOrSeedUser(env, email);
  const now = Date.now();

  if (user && user.locked_until > now) {
    const minutes = Math.ceil((user.locked_until - now) / 60000);
    return json({ error: `Terlalu banyak percobaan gagal. Coba lagi dalam ${minutes} menit.` }, 429);
  }

  let passwordOk = false;
  if (user) {
    const hash = await hashPassword(password, user.password_salt, user.iterations);
    passwordOk = timingSafeEqual(hash, user.password_hash);
  } else {
    // samakan waktu respons agar email yang tidak terdaftar tidak bisa ditebak
    await hashPassword(password, DUMMY_SALT, PBKDF2_ITERATIONS);
  }

  if (!user || !passwordOk) {
    if (user) {
      const fails = (user.failed_count || 0) + 1;
      if (fails >= LOGIN_MAX_FAILS) {
        await env.DB.prepare('UPDATE auth_users SET failed_count = 0, locked_until = ?2 WHERE id = ?1')
          .bind(user.id, now + LOGIN_LOCK_MS)
          .run();
      } else {
        await env.DB.prepare('UPDATE auth_users SET failed_count = ?2 WHERE id = ?1').bind(user.id, fails).run();
      }
    }
    return json({ error: 'Email atau password salah.' }, 401);
  }

  if (user.failed_count > 0) {
    await env.DB.prepare('UPDATE auth_users SET failed_count = 0 WHERE id = ?1').bind(user.id).run();
  }
  return issueChallenge(env, user);
}

async function handleVerify(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readJson(request);
  const challengeId = String(body.challengeId || '');
  const code = String(body.code || '').trim();
  if (!/^[a-f0-9]{32}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
    return json({ error: 'Masukkan kode 6 digit angka.' }, 400);
  }

  const now = Date.now();
  const challenge = await env.DB.prepare('SELECT * FROM auth_challenges WHERE id = ?1').bind(challengeId).first();
  if (!challenge || challenge.expires_at <= now) {
    if (challenge) await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?1').bind(challengeId).run();
    return json({ error: 'Kode kedaluwarsa. Silakan login ulang.', restart: true }, 400);
  }

  // Naikkan hitungan percobaan secara atomik SEBELUM membandingkan kode
  const bump = await env.DB.prepare(
    'UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?1 AND attempts < ?2 AND expires_at > ?3'
  )
    .bind(challengeId, OTP_MAX_ATTEMPTS, now)
    .run();
  if (!bump?.meta?.changes) {
    await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?1').bind(challengeId).run();
    return json({ error: 'Terlalu banyak kode salah. Silakan login ulang.', restart: true }, 429);
  }

  const expected = challenge.code_hash as string;
  const actual = await hashOtp(env, challengeId, code);
  if (!timingSafeEqual(actual, expected)) {
    const remaining = Math.max(0, OTP_MAX_ATTEMPTS - (challenge.attempts + 1));
    return json({ error: `Kode salah. Sisa percobaan: ${remaining}.`, remaining }, 401);
  }

  // Kode hanya boleh dipakai sekali
  const used = await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?1').bind(challengeId).run();
  if (!used?.meta?.changes) {
    return json({ error: 'Kode sudah digunakan. Silakan login ulang.', restart: true }, 400);
  }

  const user = await env.DB.prepare('SELECT id, email FROM auth_users WHERE id = ?1').bind(challenge.user_id).first();
  if (!user) return json({ error: 'Akun tidak ditemukan.' }, 401);

  const session = await createSession(env, user.id);
  return json({ ok: true, token: session.token, expiresAt: session.expiresAt, user: { email: user.email } });
}

async function handleResend(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readJson(request);
  const challengeId = String(body.challengeId || '');
  if (!/^[a-f0-9]{32}$/.test(challengeId)) return json({ error: 'Permintaan tidak valid.' }, 400);

  const now = Date.now();
  const challenge = await env.DB.prepare('SELECT * FROM auth_challenges WHERE id = ?1').bind(challengeId).first();
  if (!challenge || challenge.expires_at <= now) {
    return json({ error: 'Sesi verifikasi berakhir. Silakan login ulang.', restart: true }, 400);
  }
  if (challenge.resends >= OTP_MAX_RESENDS) {
    return json({ error: 'Batas kirim ulang tercapai. Silakan login ulang.', restart: true }, 429);
  }
  const wait = challenge.created_at + OTP_RESEND_COOLDOWN_MS - now;
  if (wait > 0) {
    return json({ error: `Tunggu ${Math.ceil(wait / 1000)} detik sebelum kirim ulang.`, retryAfterSec: Math.ceil(wait / 1000) }, 429);
  }

  const user = await env.DB.prepare('SELECT id, email FROM auth_users WHERE id = ?1').bind(challenge.user_id).first();
  if (!user) return json({ error: 'Akun tidak ditemukan.' }, 401);

  const code = randomOtp();
  await env.DB.prepare(
    'UPDATE auth_challenges SET code_hash = ?2, expires_at = ?3, created_at = ?4, resends = resends + 1 WHERE id = ?1'
  )
    .bind(challengeId, await hashOtp(env, challengeId, code), now + OTP_TTL_MS, now)
    .run();
  try {
    await sendOtpEmail(env, user.email, code);
  } catch (err) {
    return emailErrorResponse(err);
  }
  return json({
    ok: true,
    email: maskEmail(user.email),
    expiresInSec: Math.round(OTP_TTL_MS / 1000),
    resendAfterSec: Math.round(OTP_RESEND_COOLDOWN_MS / 1000),
  });
}

async function handleChangePassword(request: Request, env: AuthEnv, session: AuthSession): Promise<Response> {
  const body = await readJson(request);
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');

  const problem = validateNewPassword(newPassword, session.email);
  if (problem) return json({ error: problem }, 400);

  const user = await findUser(env, session.email);
  if (!user) return json({ error: 'Akun tidak ditemukan.' }, 401);

  const currentHash = await hashPassword(currentPassword, user.password_salt, user.iterations);
  if (!timingSafeEqual(currentHash, user.password_hash)) {
    return json({ error: 'Password saat ini salah.' }, 401);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(newPassword, salt, PBKDF2_ITERATIONS);
  await env.DB.prepare(
    'UPDATE auth_users SET password_hash = ?2, password_salt = ?3, iterations = ?4, failed_count = 0, locked_until = 0, updated_at = ?5 WHERE id = ?1'
  )
    .bind(user.id, hash, salt, PBKDF2_ITERATIONS, Date.now())
    .run();
  // Sesi lain (perangkat lain) dikeluarkan; sesi saat ini tetap aktif
  await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1 AND token_hash != ?2')
    .bind(user.id, session.tokenHash)
    .run();
  return json({ ok: true, message: 'Password berhasil diubah. Perangkat lain telah dikeluarkan.' });
}

// Mengembalikan Response bila path termasuk /api/auth/*, atau null bila bukan.
export async function handleAuthRoute(request: Request, env: AuthEnv, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/api/auth/')) return null;
  if (!env.DB) return json({ error: 'Database D1 belum terhubung ke Worker.' }, 503);

  try {
    await ensureSchema(env.DB);
    const method = request.method;

    if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(request, env);
    if (pathname === '/api/auth/verify-2fa' && method === 'POST') return await handleVerify(request, env);
    if (pathname === '/api/auth/resend' && method === 'POST') return await handleResend(request, env);

    const session = await authenticate(request, env);
    if (!session) return json({ error: 'Sesi tidak valid atau sudah berakhir.' }, 401);

    if (pathname === '/api/auth/me' && method === 'GET') return json({ ok: true, user: { email: session.email } });
    if (pathname === '/api/auth/logout' && method === 'POST') {
      await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?1').bind(session.tokenHash).run();
      return json({ ok: true });
    }
    if (pathname === '/api/auth/change-password' && method === 'POST') {
      return await handleChangePassword(request, env, session);
    }
    return json({ error: 'Not Found' }, 404);
  } catch (err: any) {
    console.error('auth error:', err?.message);
    return json({ error: 'Terjadi kesalahan pada server.' }, 500);
  }
}
