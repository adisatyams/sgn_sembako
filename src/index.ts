import { Client } from 'pg';

export interface Env {
  DB?: any; // Cloudflare D1 Database binding (5GB Gratis)
  HYPERDRIVE?: {
    connectionString: string;
  };
  DATABASE_URL?: string;
  WORKER_API_KEY?: string;
  CORS_ORIGIN?: string;
  B2_ENDPOINT?: string;
  B2_BUCKET_NAME?: string;
  WA_API_KEY?: string;
  SIPAJAK_ENV?: string;
  SIPAJAK_NPWP?: string;
  SIPAJAK_USERNAME?: string;
  SIPAJAK_PASSWORD?: string;
  RESEND_API_KEY?: string;
  RESEND_KEY?: string;
  RESEND_TOKEN?: string;
  RESEND_SECRET?: string;
  BREVO_API_KEY?: string;
  BREVO_KEY?: string;
  SIB_API_KEY?: string;
  SENDGRID_API_KEY?: string;
  SENDGRID_KEY?: string;
  POSTMARK_API_KEY?: string;
  POSTMARK_SERVER_TOKEN?: string;
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILCHANNELS_API_KEY?: string;
  SMTP2GO_API_KEY?: string;
  ZEPTOMAIL_API_KEY?: string;
  ZEPTO_API_KEY?: string;
  EMAIL_WEBHOOK_URL?: string;
  MAIL_WEBHOOK_URL?: string;
  GAS_EMAIL_URL?: string;
  OTP_WEBHOOK_URL?: string;
  AUTH_FROM_EMAIL?: string;
  FROM_EMAIL?: string;
  EMAIL_FROM?: string;
  RESEND_FROM?: string;
  MAIL_FROM?: string;
  AUTH_ADMIN_EMAIL?: string;
  AUTH_ADMIN_PASSWORD?: string;
  [key: string]: any;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function randomHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function generateOtp6(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return toHex(digest);
}

async function hashPasswordPBKDF2(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltHex || randomHex(16);
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(salt), iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { hash: toHex(derived), salt };
}

async function verifyPasswordPBKDF2(password: string, saltHex: string, expectedHash: string): Promise<boolean> {
  const { hash } = await hashPasswordPBKDF2(password, saltHex);
  if (hash.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = String(email || '').split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password: string): boolean {
  return password.length >= 10 && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
}

function extractBearerToken(request: Request): string {
  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

async function getTableColumns(db: any, table: string): Promise<Array<{ name: string; notnull: number; dflt_value: any; pk: number }>> {
  try {
    const res = await db.prepare(`PRAGMA table_info(${table})`).all();
    return Array.isArray(res?.results) ? res.results : [];
  } catch {
    return [];
  }
}

async function addMissingColumns(
  db: any,
  table: string,
  existingNames: Set<string>,
  required: Array<[string, string]>
): Promise<void> {
  for (const [colName, colDef] of required) {
    if (!existingNames.has(colName)) {
      try {
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`).run();
      } catch {
        /* abaikan jika kolom sudah ditambahkan oleh request paralel */
      }
    }
  }
}

async function recreateAuthChallengesTable(db: any): Promise<void> {
  await db.prepare('DROP TABLE IF EXISTS auth_challenges').run();
  await db
    .prepare(`CREATE TABLE auth_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_sent_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`)
    .run();
}

async function recreateAuthSessionsTable(db: any): Promise<void> {
  await db.prepare('DROP TABLE IF EXISTS auth_sessions').run();
  await db
    .prepare(`CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`)
    .run();
}

async function insertChallengeSafely(
  db: any,
  challengeId: string,
  userId: string,
  email: string,
  codeHash: string,
  expiresAt: number,
  nowMs: number
): Promise<void> {
  const createdAt = new Date(nowMs).toISOString();
  const sql =
    'INSERT INTO auth_challenges (id, user_id, email, code_hash, expires_at, last_sent_at, attempts, used, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7)';
  try {
    await db.prepare(sql).bind(challengeId, userId, email, codeHash, expiresAt, nowMs, createdAt).run();
  } catch {
    await recreateAuthChallengesTable(db);
    await db.prepare(sql).bind(challengeId, userId, email, codeHash, expiresAt, nowMs, createdAt).run();
  }
}

async function insertSessionSafely(
  db: any,
  tokenHash: string,
  userId: string,
  email: string,
  expiresAt: number
): Promise<void> {
  const createdAt = new Date().toISOString();
  const sql =
    'INSERT INTO auth_sessions (token_hash, user_id, email, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)';
  try {
    await db.prepare(sql).bind(tokenHash, userId, email, expiresAt, createdAt).run();
  } catch {
    await recreateAuthSessionsTable(db);
    await db.prepare(sql).bind(tokenHash, userId, email, expiresAt, createdAt).run();
  }
}

async function ensureAuthTables(db: any, env?: Env): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT DEFAULT 'ADMIN',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_sent_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
  ]);

  // Migrasi aman untuk tabel auth lama di D1 yang mungkin memiliki skema berbeda
  const userCols = await getTableColumns(db, 'auth_users');
  const userColNames = new Set(userCols.map((c) => String(c.name)));
  await addMissingColumns(db, 'auth_users', userColNames, [
    ['email', "TEXT DEFAULT ''"],
    ['password_hash', "TEXT DEFAULT ''"],
    ['password_salt', "TEXT DEFAULT ''"],
    ['role', "TEXT DEFAULT 'ADMIN'"],
    ['created_at', 'DATETIME'],
    ['updated_at', 'DATETIME'],
  ]);

  const challengeCols = await getTableColumns(db, 'auth_challenges');
  const allowedChallengeCols = new Set(['id', 'user_id', 'email', 'code_hash', 'expires_at', 'last_sent_at', 'attempts', 'used', 'created_at']);
  const hasBlockingChallengeCol =
    !challengeCols.some((c) => c.name === 'id') ||
    challengeCols.some(
      (c) =>
        !allowedChallengeCols.has(String(c.name)) &&
        ((Number(c.notnull) === 1 && c.dflt_value === null) || Number(c.pk) === 1)
    );

  if (hasBlockingChallengeCol) {
    await recreateAuthChallengesTable(db);
  } else {
    const chColNames = new Set(challengeCols.map((c) => String(c.name)));
    await addMissingColumns(db, 'auth_challenges', chColNames, [
      ['user_id', "TEXT DEFAULT ''"],
      ['email', "TEXT DEFAULT ''"],
      ['code_hash', "TEXT DEFAULT ''"],
      ['expires_at', 'INTEGER DEFAULT 0'],
      ['last_sent_at', 'INTEGER DEFAULT 0'],
      ['attempts', 'INTEGER DEFAULT 0'],
      ['used', 'INTEGER DEFAULT 0'],
      ['created_at', 'DATETIME'],
    ]);
  }

  const sessionCols = await getTableColumns(db, 'auth_sessions');
  const allowedSessionCols = new Set(['token_hash', 'user_id', 'email', 'expires_at', 'created_at']);
  const hasBlockingSessionCol =
    !sessionCols.some((c) => c.name === 'token_hash') ||
    sessionCols.some(
      (c) =>
        !allowedSessionCols.has(String(c.name)) &&
        ((Number(c.notnull) === 1 && c.dflt_value === null) || Number(c.pk) === 1)
    );

  if (hasBlockingSessionCol) {
    await recreateAuthSessionsTable(db);
  } else {
    const sesColNames = new Set(sessionCols.map((c) => String(c.name)));
    await addMissingColumns(db, 'auth_sessions', sesColNames, [
      ['user_id', "TEXT DEFAULT ''"],
      ['email', "TEXT DEFAULT ''"],
      ['expires_at', 'INTEGER DEFAULT 0'],
      ['created_at', 'DATETIME'],
    ]);
  }

  if (env?.AUTH_ADMIN_EMAIL && env?.AUTH_ADMIN_PASSWORD) {
    const countRow: any = await db.prepare('SELECT COUNT(*) AS cnt FROM auth_users').first();
    if (Number(countRow?.cnt || 0) === 0) {
      const adminEmail = env.AUTH_ADMIN_EMAIL.trim().toLowerCase();
      const { hash, salt } = await hashPasswordPBKDF2(env.AUTH_ADMIN_PASSWORD);
      const nowIso = new Date().toISOString();
      await db
        .prepare('INSERT OR IGNORE INTO auth_users (id, email, password_hash, password_salt, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(`usr-${randomHex(8)}`, adminEmail, hash, salt, 'ADMIN', nowIso, nowIso)
        .run();
    }
  }
}

function pickEnv(env: Record<string, any> | undefined, keys: string[]): string {
  if (!env) return '';
  for (const k of keys) {
    const v = env[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function getConfiguredEmailKeys(env: Record<string, any> | undefined): string[] {
  if (!env) return [];
  const pattern = /^(RESEND|BREVO|SIB|SENDGRID|MAILGUN|POSTMARK|MAILCHANNELS|SMTP|GMAIL|ZEPTO|EMAIL|MAIL|OTP_WEBHOOK|AUTH_FROM|FROM_EMAIL)/i;
  return Object.keys(env)
    .filter((k) => pattern.test(k) && typeof env[k] === 'string' && env[k].trim().length > 0)
    .sort();
}

function resolveEmailProviderConfig(env: Record<string, any> | undefined): { configured: boolean; provider?: string } {
  if (pickEnv(env, ['RESEND_API_KEY', 'RESEND_KEY', 'RESEND_TOKEN', 'RESEND_SECRET'])) return { configured: true, provider: 'resend' };
  if (pickEnv(env, ['BREVO_API_KEY', 'BREVO_KEY', 'SIB_API_KEY'])) return { configured: true, provider: 'brevo' };
  if (pickEnv(env, ['SENDGRID_API_KEY', 'SENDGRID_KEY'])) return { configured: true, provider: 'sendgrid' };
  if (pickEnv(env, ['POSTMARK_API_KEY', 'POSTMARK_SERVER_TOKEN'])) return { configured: true, provider: 'postmark' };
  if (pickEnv(env, ['MAILGUN_API_KEY']) && pickEnv(env, ['MAILGUN_DOMAIN'])) return { configured: true, provider: 'mailgun' };
  if (pickEnv(env, ['SMTP2GO_API_KEY'])) return { configured: true, provider: 'smtp2go' };
  if (pickEnv(env, ['ZEPTOMAIL_API_KEY', 'ZEPTO_API_KEY'])) return { configured: true, provider: 'zeptomail' };
  if (pickEnv(env, ['MAILCHANNELS_API_KEY'])) return { configured: true, provider: 'mailchannels' };
  if (pickEnv(env, ['EMAIL_WEBHOOK_URL', 'MAIL_WEBHOOK_URL', 'GAS_EMAIL_URL', 'OTP_WEBHOOK_URL'])) return { configured: true, provider: 'webhook' };
  return { configured: false };
}

function parseSenderAddress(raw: string): { name: string; email: string; formatted: string } {
  const clean = (raw || '').trim() || 'SGN Sembako <onboarding@resend.dev>';
  const match = clean.match(/^(.*)<([^<>]+)>$/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '') || 'SGN Sembako';
    const email = match[2].trim();
    return { name, email, formatted: `${name} <${email}>` };
  }
  return { name: 'SGN Sembako', email: clean, formatted: `SGN Sembako <${clean}>` };
}

async function readErrSnippet(res: Response): Promise<string> {
  try {
    const txt = (await res.text()).replace(/\s+/g, ' ').trim();
    return txt.slice(0, 220);
  } catch {
    return '';
  }
}

async function sendOtpEmail(
  env: Env,
  email: string,
  otp: string
): Promise<{ sent: boolean; provider?: string; error?: string }> {
  const fromRaw = pickEnv(env, ['AUTH_FROM_EMAIL', 'FROM_EMAIL', 'EMAIL_FROM', 'RESEND_FROM', 'MAIL_FROM']);
  const sender = parseSenderAddress(fromRaw);
  const subject = `Kode Verifikasi Login SGN Sembako: ${otp}`;
  const text = `Kode verifikasi 2 langkah SGN Sembako Anda: ${otp} (berlaku 5 menit). Jika Anda tidak mencoba masuk, abaikan email ini.`;
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;">
    <h2 style="color:#0f172a;margin:0 0 8px;">Verifikasi 2 Langkah SGN Sembako</h2>
    <p style="color:#475569;font-size:14px;">Gunakan kode 6 digit berikut untuk menyelesaikan login ke ERP (berlaku 5 menit):</p>
    <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#d97706;background:#fffbeb;padding:16px;text-align:center;border-radius:8px;margin:16px 0;">${otp}</div>
    <p style="color:#64748b;font-size:12px;">Jika Anda tidak mencoba masuk, abaikan email ini.</p>
  </div>`;

  const errors: string[] = [];

  const resendKey = pickEnv(env, ['RESEND_API_KEY', 'RESEND_KEY', 'RESEND_TOKEN', 'RESEND_SECRET']);
  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: sender.formatted, to: [email], subject, html, text }),
      });
      if (res.ok) return { sent: true, provider: 'resend' };
      const snippet = await readErrSnippet(res);
      errors.push(`Resend HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`Resend error: ${err?.message || 'gagal fetch'}`);
    }
  }

  const brevoKey = pickEnv(env, ['BREVO_API_KEY', 'BREVO_KEY', 'SIB_API_KEY']);
  if (brevoKey) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: sender.name, email: fromRaw ? sender.email : email },
          to: [{ email }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });
      if (res.ok) return { sent: true, provider: 'brevo' };
      const snippet = await readErrSnippet(res);
      errors.push(`Brevo HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`Brevo error: ${err?.message || 'gagal fetch'}`);
    }
  }

  const sendgridKey = pickEnv(env, ['SENDGRID_API_KEY', 'SENDGRID_KEY']);
  if (sendgridKey) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sendgridKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: fromRaw ? sender.email : email, name: sender.name },
          subject,
          content: [
            { type: 'text/plain', value: text },
            { type: 'text/html', value: html },
          ],
        }),
      });
      if (res.ok) return { sent: true, provider: 'sendgrid' };
      const snippet = await readErrSnippet(res);
      errors.push(`SendGrid HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`SendGrid error: ${err?.message || 'gagal fetch'}`);
    }
  }

  const postmarkKey = pickEnv(env, ['POSTMARK_API_KEY', 'POSTMARK_SERVER_TOKEN']);
  if (postmarkKey) {
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': postmarkKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          From: fromRaw ? sender.formatted : email,
          To: email,
          Subject: subject,
          HtmlBody: html,
          TextBody: text,
        }),
      });
      if (res.ok) return { sent: true, provider: 'postmark' };
      const snippet = await readErrSnippet(res);
      errors.push(`Postmark HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`Postmark error: ${err?.message || 'gagal fetch'}`);
    }
  }

  const mailgunKey = pickEnv(env, ['MAILGUN_API_KEY']);
  const mailgunDomain = pickEnv(env, ['MAILGUN_DOMAIN']);
  if (mailgunKey && mailgunDomain) {
    try {
      const form = new URLSearchParams({
        from: fromRaw ? sender.formatted : `SGN Sembako <noreply@${mailgunDomain}>`,
        to: email,
        subject,
        text,
        html,
      });
      const res = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(`api:${mailgunKey}`)}` },
        body: form,
      });
      if (res.ok) return { sent: true, provider: 'mailgun' };
      const snippet = await readErrSnippet(res);
      errors.push(`Mailgun HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`Mailgun error: ${err?.message || 'gagal fetch'}`);
    }
  }

  const smtp2goKey = pickEnv(env, ['SMTP2GO_API_KEY']);
  if (smtp2goKey) {
    try {
      const res = await fetch('https://api.smtp2go.com/v3/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: smtp2goKey,
          sender: fromRaw ? sender.formatted : email,
          to: [email],
          subject,
          text_body: text,
          html_body: html,
        }),
      });
      if (res.ok) return { sent: true, provider: 'smtp2go' };
      const snippet = await readErrSnippet(res);
      errors.push(`SMTP2GO HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`SMTP2GO error: ${err?.message || 'gagal fetch'}`);
    }
  }

  const zeptoKey = pickEnv(env, ['ZEPTOMAIL_API_KEY', 'ZEPTO_API_KEY']);
  if (zeptoKey) {
    try {
      const authHeader = zeptoKey.startsWith('Zoho-enczapikey ') ? zeptoKey : `Zoho-enczapikey ${zeptoKey}`;
      const res = await fetch('https://api.zeptomail.com/v1.1/email', {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          from: { address: fromRaw ? sender.email : email, name: sender.name },
          to: [{ email_address: { address: email } }],
          subject,
          htmlbody: html,
        }),
      });
      if (res.ok) return { sent: true, provider: 'zeptomail' };
      const snippet = await readErrSnippet(res);
      errors.push(`ZeptoMail HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`ZeptoMail error: ${err?.message || 'gagal fetch'}`);
    }
  }

  const mailchannelsKey = pickEnv(env, ['MAILCHANNELS_API_KEY']);
  if (mailchannelsKey) {
    try {
      const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
        method: 'POST',
        headers: { 'X-Api-Key': mailchannelsKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: sender.email, name: sender.name },
          subject,
          content: [
            { type: 'text/plain', value: text },
            { type: 'text/html', value: html },
          ],
        }),
      });
      if (res.ok) return { sent: true, provider: 'mailchannels' };
      const snippet = await readErrSnippet(res);
      errors.push(`MailChannels HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`MailChannels error: ${err?.message || 'gagal fetch'}`);
    }
  }

  const webhookUrl = pickEnv(env, ['EMAIL_WEBHOOK_URL', 'MAIL_WEBHOOK_URL', 'GAS_EMAIL_URL', 'OTP_WEBHOOK_URL']);
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: email, email, from: sender.formatted, subject, otp, code: otp, text, html }),
      });
      if (res.ok) return { sent: true, provider: 'webhook' };
      const snippet = await readErrSnippet(res);
      errors.push(`Webhook HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
    } catch (err: any) {
      errors.push(`Webhook error: ${err?.message || 'gagal fetch'}`);
    }
  }

  if (errors.length > 0) {
    return { sent: false, provider: resolveEmailProviderConfig(env).provider, error: errors.join(' | ') };
  }
  return {
    sent: false,
    error: 'Secret provider email (RESEND_API_KEY / BREVO_API_KEY / SENDGRID_API_KEY / EMAIL_WEBHOOK_URL) belum diatur pada Worker.',
  };
}

function getDbClient(env: Env): Client {
  const connString = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!connString) {
    throw new Error('DATABASE_URL or HYPERDRIVE missing');
  }
  return new Client({
    connectionString: connString,
    ssl: { rejectUnauthorized: false }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-KEY, Accept',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. Health check
      if (pathname === '/' || pathname === '/api/health' || pathname === '/health') {
        let dbOk = false;
        let dbType = 'Belum Dikonfigurasi';

        if (env.DB) {
          try {
            await env.DB.prepare('SELECT 1').run();
            dbOk = true;
            dbType = 'Cloudflare D1 SQLite (5GB Gratis)';
          } catch {
            dbOk = false;
          }
        } else if (env.HYPERDRIVE || env.DATABASE_URL) {
          try {
            const client = getDbClient(env);
            await client.connect();
            await client.query('SELECT 1');
            dbOk = true;
            dbType = 'Aiven PostgreSQL';
            await client.end();
          } catch {
            dbOk = false;
          }
        }

        return Response.json({
          status: 'ONLINE',
          service: 'MinyakKu Cloudflare Worker API',
          db_connected: dbOk,
          d1_enabled: !!env.DB,
          hyperdrive_enabled: !!env.HYPERDRIVE,
          db_type: dbType,
          message: dbOk ? `Terhubung ke ${dbType}` : 'Worker aktif (Menunggu konfigurasi database)'
        }, { headers: corsHeaders });
      }

      // 1B. Autentikasi + 2FA (/api/auth/*)
      if (pathname.startsWith('/api/auth/')) {
        if (!env.DB) {
          return Response.json(
            { error: 'Cloudflare D1 belum terhubung ke Worker.' },
            { status: 500, headers: corsHeaders }
          );
        }

        await ensureAuthTables(env.DB, env);

        if (pathname === '/api/auth/setup-status' && method === 'GET') {
          const countRow: any = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM auth_users').first();
          const mailCfg = resolveEmailProviderConfig(env);
          return Response.json(
            {
              hasUsers: Number(countRow?.cnt || 0) > 0,
              emailProviderConfigured: mailCfg.configured,
              emailProvider: mailCfg.provider || null,
              detectedMailKeys: getConfiguredEmailKeys(env),
            },
            { headers: corsHeaders }
          );
        }

        if (pathname === '/api/auth/setup' && method === 'POST') {
          const countRow: any = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM auth_users').first();
          if (Number(countRow?.cnt || 0) > 0) {
            return Response.json(
              { error: 'Akun admin sudah terdaftar. Silakan login dengan akun Anda.' },
              { status: 403, headers: corsHeaders }
            );
          }
          const body: any = await request.json().catch(() => ({}));
          const email = String(body.email || '').trim().toLowerCase();
          const password = String(body.password || '');
          if (!isValidEmail(email)) {
            return Response.json({ error: 'Format email tidak valid.' }, { status: 400, headers: corsHeaders });
          }
          if (!isStrongPassword(password)) {
            return Response.json(
              { error: 'Password minimal 10 karakter dan harus mengandung huruf serta angka.' },
              { status: 400, headers: corsHeaders }
            );
          }

          const userId = `usr-${randomHex(8)}`;
          const { hash, salt } = await hashPasswordPBKDF2(password);
          const nowIso = new Date().toISOString();
          await env.DB.prepare(
            'INSERT INTO auth_users (id, email, password_hash, password_salt, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
          )
            .bind(userId, email, hash, salt, 'ADMIN', nowIso, nowIso)
            .run();

          const challengeId = `chg-${randomHex(16)}`;
          const otp = generateOtp6();
          const codeHash = await sha256Hex(`${otp}:${challengeId}`);
          const now = Date.now();
          await insertChallengeSafely(env.DB, challengeId, userId, email, codeHash, now + 5 * 60 * 1000, now);

          const mailResult = await sendOtpEmail(env, email, otp);
          return Response.json(
            {
              ok: true,
              challengeId,
              email: maskEmail(email),
              resendAfterSec: 60,
              emailSent: mailResult.sent,
              emailProvider: mailResult.provider || null,
              ...(mailResult.error ? { emailError: mailResult.error } : {}),
              detectedMailKeys: getConfiguredEmailKeys(env),
              ...(mailResult.sent ? {} : { devOtp: otp }),
            },
            { headers: corsHeaders }
          );
        }

        if (pathname === '/api/auth/login' && method === 'POST') {
          const body: any = await request.json().catch(() => ({}));
          const email = String(body.email || '').trim().toLowerCase();
          const password = String(body.password || '');
          if (!email || !password) {
            return Response.json(
              { error: 'Email dan password wajib diisi.' },
              { status: 400, headers: corsHeaders }
            );
          }

          const countRow: any = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM auth_users').first();
          if (Number(countRow?.cnt || 0) === 0) {
            return Response.json(
              {
                error: 'Belum ada akun admin terdaftar di server ini. Silakan buat akun admin pertama.',
                needsSetup: true,
              },
              { status: 400, headers: corsHeaders }
            );
          }

          const user: any = await env.DB.prepare('SELECT * FROM auth_users WHERE email = ?1 LIMIT 1')
            .bind(email)
            .first();
          if (!user) {
            return Response.json({ error: 'Email atau password salah.' }, { status: 401, headers: corsHeaders });
          }

          const ok = await verifyPasswordPBKDF2(password, String(user.password_salt), String(user.password_hash));
          if (!ok) {
            return Response.json({ error: 'Email atau password salah.' }, { status: 401, headers: corsHeaders });
          }

          const challengeId = `chg-${randomHex(16)}`;
          const otp = generateOtp6();
          const codeHash = await sha256Hex(`${otp}:${challengeId}`);
          const now = Date.now();
          await insertChallengeSafely(env.DB, challengeId, String(user.id), String(user.email), codeHash, now + 5 * 60 * 1000, now);

          const mailResult = await sendOtpEmail(env, String(user.email), otp);
          return Response.json(
            {
              ok: true,
              challengeId,
              email: maskEmail(String(user.email)),
              resendAfterSec: 60,
              emailSent: mailResult.sent,
              emailProvider: mailResult.provider || null,
              ...(mailResult.error ? { emailError: mailResult.error } : {}),
              detectedMailKeys: getConfiguredEmailKeys(env),
              ...(mailResult.sent ? {} : { devOtp: otp }),
            },
            { headers: corsHeaders }
          );
        }

        if (pathname === '/api/auth/verify-2fa' && method === 'POST') {
          const body: any = await request.json().catch(() => ({}));
          const challengeId = String(body.challengeId || '').trim();
          const code = String(body.code || '').replace(/\D/g, '');
          if (!challengeId || code.length !== 6) {
            return Response.json(
              { error: 'Kode verifikasi harus 6 digit.' },
              { status: 400, headers: corsHeaders }
            );
          }

          const ch: any = await env.DB.prepare('SELECT * FROM auth_challenges WHERE id = ?1 LIMIT 1')
            .bind(challengeId)
            .first();
          if (!ch || Number(ch.used) === 1) {
            return Response.json(
              { error: 'Sesi verifikasi sudah tidak berlaku. Silakan login ulang.', restart: true },
              { status: 400, headers: corsHeaders }
            );
          }
          if (Date.now() > Number(ch.expires_at)) {
            await env.DB.prepare('UPDATE auth_challenges SET used = 1 WHERE id = ?1').bind(challengeId).run();
            return Response.json(
              { error: 'Kode verifikasi kedaluwarsa. Silakan login ulang.', restart: true },
              { status: 400, headers: corsHeaders }
            );
          }

          const nextAttempts = Number(ch.attempts || 0) + 1;
          const expectedHash = await sha256Hex(`${code}:${challengeId}`);
          if (expectedHash !== String(ch.code_hash)) {
            if (nextAttempts >= 5) {
              await env.DB.prepare('UPDATE auth_challenges SET attempts = ?1, used = 1 WHERE id = ?2')
                .bind(nextAttempts, challengeId)
                .run();
              return Response.json(
                { error: 'Terlalu banyak percobaan salah. Silakan login ulang.', restart: true },
                { status: 401, headers: corsHeaders }
              );
            }
            await env.DB.prepare('UPDATE auth_challenges SET attempts = ?1 WHERE id = ?2')
              .bind(nextAttempts, challengeId)
              .run();
            return Response.json({ error: 'Kode verifikasi 6 digit salah.' }, { status: 401, headers: corsHeaders });
          }

          let resolvedEmail = String(ch.email || '').trim();
          if (!resolvedEmail && ch.user_id) {
            const uRow: any = await env.DB.prepare('SELECT email FROM auth_users WHERE id = ?1 LIMIT 1').bind(ch.user_id).first();
            resolvedEmail = String(uRow?.email || '');
          }

          const token = randomHex(32);
          const tokenHash = await sha256Hex(token);
          const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
          await env.DB.prepare('UPDATE auth_challenges SET used = 1 WHERE id = ?1').bind(challengeId).run();
          await insertSessionSafely(env.DB, tokenHash, String(ch.user_id), resolvedEmail, expiresAt);

          return Response.json(
            {
              ok: true,
              token,
              expiresAt,
              user: { email: resolvedEmail },
            },
            { headers: corsHeaders }
          );
        }

        if (pathname === '/api/auth/resend' && method === 'POST') {
          const body: any = await request.json().catch(() => ({}));
          const challengeId = String(body.challengeId || '').trim();
          const ch: any = await env.DB.prepare('SELECT * FROM auth_challenges WHERE id = ?1 LIMIT 1')
            .bind(challengeId)
            .first();
          if (!ch || Number(ch.used) === 1 || Date.now() > Number(ch.expires_at)) {
            return Response.json(
              { error: 'Sesi verifikasi berakhir. Silakan login ulang.', restart: true },
              { status: 400, headers: corsHeaders }
            );
          }

          const now = Date.now();
          const elapsed = now - Number(ch.last_sent_at || 0);
          if (elapsed < 60_000) {
            const retryAfterSec = Math.max(1, Math.ceil((60_000 - elapsed) / 1000));
            return Response.json(
              { error: `Tunggu ${retryAfterSec} detik sebelum mengirim ulang kode.`, retryAfterSec },
              { status: 429, headers: corsHeaders }
            );
          }

          let resolvedEmail = String(ch.email || '').trim();
          if (!resolvedEmail && ch.user_id) {
            const uRow: any = await env.DB.prepare('SELECT email FROM auth_users WHERE id = ?1 LIMIT 1').bind(ch.user_id).first();
            resolvedEmail = String(uRow?.email || '');
          }

          const otp = generateOtp6();
          const codeHash = await sha256Hex(`${otp}:${challengeId}`);
          await env.DB.prepare(
            'UPDATE auth_challenges SET code_hash = ?1, expires_at = ?2, last_sent_at = ?3, attempts = 0 WHERE id = ?4'
          )
            .bind(codeHash, now + 5 * 60 * 1000, now, challengeId)
            .run();

          const mailResult = await sendOtpEmail(env, resolvedEmail, otp);
          return Response.json(
            {
              ok: true,
              resendAfterSec: 60,
              emailSent: mailResult.sent,
              emailProvider: mailResult.provider || null,
              ...(mailResult.error ? { emailError: mailResult.error } : {}),
              detectedMailKeys: getConfiguredEmailKeys(env),
              ...(mailResult.sent ? {} : { devOtp: otp }),
            },
            { headers: corsHeaders }
          );
        }

        if (pathname === '/api/auth/me' && method === 'GET') {
          const token = extractBearerToken(request);
          if (!token) {
            return Response.json({ error: 'Token sesi tidak ditemukan.' }, { status: 401, headers: corsHeaders });
          }
          const tokenHash = await sha256Hex(token);
          const session: any = await env.DB.prepare(
            'SELECT * FROM auth_sessions WHERE token_hash = ?1 AND expires_at > ?2 LIMIT 1'
          )
            .bind(tokenHash, Date.now())
            .first();
          if (!session) {
            return Response.json({ error: 'Sesi login tidak valid atau kedaluwarsa.' }, { status: 401, headers: corsHeaders });
          }
          let resolvedEmail = String(session.email || '').trim();
          if (!resolvedEmail && session.user_id) {
            const uRow: any = await env.DB.prepare('SELECT email FROM auth_users WHERE id = ?1 LIMIT 1').bind(session.user_id).first();
            resolvedEmail = String(uRow?.email || '');
          }
          return Response.json({ ok: true, user: { email: resolvedEmail } }, { headers: corsHeaders });
        }

        if (pathname === '/api/auth/logout' && method === 'POST') {
          const token = extractBearerToken(request);
          if (token) {
            const tokenHash = await sha256Hex(token);
            await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?1').bind(tokenHash).run();
          }
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        if (pathname === '/api/auth/change-password' && method === 'POST') {
          const token = extractBearerToken(request);
          if (!token) {
            return Response.json({ error: 'Sesi berakhir. Silakan login ulang.' }, { status: 401, headers: corsHeaders });
          }
          const tokenHash = await sha256Hex(token);
          const session: any = await env.DB.prepare(
            'SELECT * FROM auth_sessions WHERE token_hash = ?1 AND expires_at > ?2 LIMIT 1'
          )
            .bind(tokenHash, Date.now())
            .first();
          if (!session) {
            return Response.json({ error: 'Sesi berakhir. Silakan login ulang.' }, { status: 401, headers: corsHeaders });
          }

          const body: any = await request.json().catch(() => ({}));
          const currentPassword = String(body.currentPassword || '');
          const newPassword = String(body.newPassword || '');
          if (!isStrongPassword(newPassword)) {
            return Response.json(
              { error: 'Password baru minimal 10 karakter dan harus mengandung huruf serta angka.' },
              { status: 400, headers: corsHeaders }
            );
          }

          const user: any = await env.DB.prepare('SELECT * FROM auth_users WHERE id = ?1 LIMIT 1')
            .bind(session.user_id)
            .first();
          if (!user) {
            return Response.json({ error: 'Pengguna tidak ditemukan.' }, { status: 404, headers: corsHeaders });
          }

          const currentOk = await verifyPasswordPBKDF2(
            currentPassword,
            String(user.password_salt),
            String(user.password_hash)
          );
          if (!currentOk) {
            return Response.json({ error: 'Password saat ini salah.' }, { status: 401, headers: corsHeaders });
          }

          const { hash, salt } = await hashPasswordPBKDF2(newPassword);
          await env.DB.prepare(
            'UPDATE auth_users SET password_hash = ?1, password_salt = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3'
          )
            .bind(hash, salt, user.id)
            .run();

          return Response.json({ ok: true, message: 'Password berhasil diperbarui.' }, { headers: corsHeaders });
        }
      }

      // 2. Init DB
      if ((pathname === '/api/init-db' || pathname === '/init-db') && method === 'POST') {
        if (env.DB) {
          // Cloudflare D1 SQLite - 9 Tabel Lengkap
          await env.DB.batch([
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS company_profiles (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              legal_type TEXT DEFAULT 'PT',
              brand_name TEXT,
              is_pkp INTEGER DEFAULT 1,
              npwp TEXT,
              nitku TEXT,
              kpp_name TEXT,
              phone TEXT,
              email TEXT,
              office_address TEXT,
              city TEXT,
              data_json TEXT,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS customers (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              company_name TEXT,
              tier TEXT NOT NULL DEFAULT 'END_USER',
              phone TEXT NOT NULL,
              email TEXT,
              address TEXT NOT NULL,
              city TEXT,
              is_pkp INTEGER DEFAULT 0,
              npwp TEXT,
              nik TEXT,
              credit_limit REAL DEFAULT 0,
              current_receivable REAL DEFAULT 0,
              payment_terms TEXT DEFAULT 'CASH_BEFORE_DELIVERY',
              notes TEXT,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS resellers (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              nik TEXT NOT NULL,
              npwp TEXT,
              shop_name TEXT,
              area TEXT,
              phone TEXT NOT NULL,
              tier_level TEXT DEFAULT 'BRONZE',
              commission_rate_pct REAL DEFAULT 2.5,
              credit_limit REAL DEFAULT 10000000,
              balance_owed REAL DEFAULT 0,
              status TEXT DEFAULT 'ACTIVE',
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS warehouses (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              location TEXT,
              address TEXT NOT NULL,
              pic_name TEXT,
              pic_phone TEXT,
              capacity_liters REAL DEFAULT 100000,
              current_stock_liters REAL DEFAULT 0,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              category TEXT NOT NULL,
              packaging_unit TEXT NOT NULL,
              liters_per_unit REAL DEFAULT 1,
              hpp_price REAL NOT NULL,
              price_end_user REAL NOT NULL,
              price_reseller REAL NOT NULL,
              price_grosir REAL NOT NULL,
              min_stock_alert REAL DEFAULT 100,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS stock_batches (
              id TEXT PRIMARY KEY,
              warehouse_id TEXT NOT NULL,
              product_sku_id TEXT NOT NULL,
              supplier_name TEXT NOT NULL,
              batch_number TEXT NOT NULL,
              expired_date TEXT,
              qty REAL NOT NULL,
              unit TEXT NOT NULL,
              inbound_date TEXT,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS sales_orders (
              id TEXT PRIMARY KEY,
              order_number TEXT UNIQUE NOT NULL,
              order_date TEXT,
              customer_id TEXT,
              customer_name TEXT,
              customer_tier TEXT,
              sales_person TEXT,
              subtotal_dpp REAL DEFAULT 0,
              ppn_amount REAL DEFAULT 0,
              grand_total REAL DEFAULT 0,
              payment_unique_code INTEGER DEFAULT 0,
              unique_transfer_amount REAL DEFAULT 0,
              negotiation_status TEXT DEFAULT 'NOT_NEEDED',
              payment_status TEXT DEFAULT 'UNPAID',
              payment_method TEXT DEFAULT 'MANUAL_TRANSFER',
              dispatch_status TEXT DEFAULT 'WAITING_PRICE_APPROVAL',
              notes TEXT,
              items_json TEXT,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS surat_jalan (
              id TEXT PRIMARY KEY,
              sj_number TEXT UNIQUE NOT NULL,
              sales_order_id TEXT,
              sales_order_number TEXT NOT NULL,
              date TEXT,
              customer_name TEXT,
              warehouse_name TEXT NOT NULL,
              driver_name TEXT NOT NULL,
              vehicle_plate_number TEXT NOT NULL,
              status TEXT DEFAULT 'IN_TRANSIT',
              items_json TEXT,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS invoices (
              id TEXT PRIMARY KEY,
              invoice_number TEXT UNIQUE NOT NULL,
              sales_order_id TEXT,
              order_number TEXT NOT NULL,
              date TEXT,
              due_date TEXT,
              subtotal_dpp REAL DEFAULT 0,
              ppn_amount REAL DEFAULT 0,
              grand_total REAL DEFAULT 0,
              payment_status TEXT DEFAULT 'UNPAID',
              faktur_pajak_number TEXT,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS suppliers (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              brand_names TEXT,
              is_pkp INTEGER DEFAULT 1,
              npwp TEXT NOT NULL,
              nib TEXT,
              phone TEXT NOT NULL,
              email TEXT,
              pic_name TEXT NOT NULL,
              pic_phone TEXT NOT NULL,
              address TEXT NOT NULL,
              city TEXT,
              payment_terms TEXT DEFAULT 'TOP_14',
              status TEXT DEFAULT 'ACTIVE',
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS purchase_orders (
              id TEXT PRIMARY KEY,
              po_number TEXT UNIQUE NOT NULL,
              order_date TEXT NOT NULL,
              expected_delivery_date TEXT,
              supplier_id TEXT NOT NULL,
              supplier_name TEXT NOT NULL,
              supplier_npwp TEXT,
              target_warehouse_id TEXT NOT NULL,
              target_warehouse_name TEXT NOT NULL,
              subtotal_dpp REAL DEFAULT 0,
              ppn_amount REAL DEFAULT 0,
              pph22_amount REAL DEFAULT 0,
              grand_total REAL DEFAULT 0,
              payment_status TEXT DEFAULT 'UNPAID',
              delivery_status TEXT DEFAULT 'ORDERED',
              faktur_pajak_number TEXT,
              faktur_pajak_date TEXT,
              faktur_pajak_file_url TEXT,
              drive_file_id TEXT,
              drive_web_view_link TEXT,
              items_json TEXT,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              received_at DATETIME
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS operational_expenses (
              id TEXT PRIMARY KEY,
              expense_date TEXT NOT NULL,
              category TEXT NOT NULL,
              description TEXT NOT NULL,
              amount REAL DEFAULT 0,
              payment_account TEXT,
              reference_number TEXT,
              warehouse_name TEXT,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS cash_inflows (
              id TEXT PRIMARY KEY,
              inflow_date TEXT NOT NULL,
              inflow_type TEXT NOT NULL,
              source_name TEXT NOT NULL,
              description TEXT NOT NULL,
              principal_amount REAL DEFAULT 0,
              tenor_months INTEGER DEFAULT 0,
              annual_interest_rate_pct REAL DEFAULT 0,
              interest_tax_rate_pct REAL DEFAULT 15,
              paid_installments INTEGER DEFAULT 0,
              destination_account TEXT,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS employees (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              role_title TEXT NOT NULL,
              department TEXT,
              payroll_scheme TEXT NOT NULL,
              ptkp_status TEXT NOT NULL,
              npwp_or_nik TEXT,
              base_salary REAL DEFAULT 0,
              fixed_allowance REAL DEFAULT 0,
              status TEXT DEFAULT 'ACTIVE',
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS payroll_records (
              id TEXT PRIMARY KEY,
              period_month TEXT NOT NULL,
              pay_date TEXT NOT NULL,
              employee_id TEXT NOT NULL,
              employee_name TEXT NOT NULL,
              payroll_scheme TEXT NOT NULL,
              gross_pay REAL DEFAULT 0,
              pph21_amount REAL DEFAULT 0,
              net_take_home_pay REAL DEFAULT 0,
              data_json TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`)
          ]);
          // Migrasi aman untuk tabel D1 eksisting
          try {
            await env.DB.prepare('ALTER TABLE sales_orders ADD COLUMN payment_unique_code INTEGER DEFAULT 0').run();
          } catch {}
          try {
            await env.DB.prepare('ALTER TABLE sales_orders ADD COLUMN unique_transfer_amount REAL DEFAULT 0').run();
          } catch {}
          await ensureAuthTables(env.DB, env);
          return Response.json({ success: true, message: '18 Tabel Cloudflare D1 SQLite (15 ERP + 3 Auth/2FA) berhasil disiapkan (5GB Storage Siap)!' }, { headers: corsHeaders });
        }

        // Aiven PostgreSQL Fallback
        const client = getDbClient(env);
        await client.connect();
        await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
        await client.query(`
          CREATE TABLE IF NOT EXISTS customers (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            code VARCHAR(50) UNIQUE NOT NULL,
            name VARCHAR(255) NOT NULL,
            company_name VARCHAR(255),
            tier VARCHAR(50) NOT NULL DEFAULT 'END_USER',
            phone VARCHAR(50) NOT NULL,
            email VARCHAR(150),
            address TEXT NOT NULL,
            city VARCHAR(100),
            is_pkp BOOLEAN DEFAULT FALSE,
            npwp VARCHAR(50),
            nik VARCHAR(50),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS resellers (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            code VARCHAR(50) UNIQUE NOT NULL,
            name VARCHAR(255) NOT NULL,
            nik VARCHAR(50) NOT NULL,
            npwp VARCHAR(50),
            shop_name VARCHAR(255),
            area VARCHAR(150),
            phone VARCHAR(50) NOT NULL,
            tier_level VARCHAR(50) DEFAULT 'BRONZE',
            commission_rate_pct NUMERIC(5, 2) DEFAULT 2.5,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS sales_orders (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            order_number VARCHAR(100) UNIQUE NOT NULL,
            order_date DATE DEFAULT CURRENT_DATE,
            customer_name VARCHAR(255) NOT NULL,
            customer_tier VARCHAR(50) NOT NULL,
            sales_person VARCHAR(150),
            subtotal_dpp NUMERIC(15, 2) DEFAULT 0,
            ppn_amount NUMERIC(15, 2) DEFAULT 0,
            grand_total NUMERIC(15, 2) DEFAULT 0,
            negotiation_status VARCHAR(50) DEFAULT 'NOT_NEEDED',
            payment_status VARCHAR(50) DEFAULT 'UNPAID',
            dispatch_status VARCHAR(50) DEFAULT 'WAITING_PRICE_APPROVAL',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS surat_jalan (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            sj_number VARCHAR(100) UNIQUE NOT NULL,
            sales_order_number VARCHAR(100) NOT NULL,
            date DATE DEFAULT CURRENT_DATE,
            warehouse_name VARCHAR(150) NOT NULL,
            driver_name VARCHAR(150) NOT NULL,
            vehicle_plate_number VARCHAR(50) NOT NULL,
            status VARCHAR(50) DEFAULT 'IN_TRANSIT',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
        `);
        await client.end();
        return Response.json({ success: true, message: 'Tabel database PostgreSQL berhasil disiapkan!' }, { headers: corsHeaders });
      }

      // 3. Sync Push
      if ((pathname === '/api/sync/push' || pathname === '/sync/push') && method === 'POST') {
        const payload: any = await request.json();
        let insertedOrders = 0;

        // A. JIKA MENGGUNAKAN CLOUDFLARE D1 DATABASE (5GB GRATIS)
        if (env.DB) {
          const stmts: any[] = [];
          let savedStats = {
            company: 0,
            customers: 0,
            resellers: 0,
            warehouses: 0,
            products: 0,
            stockBatches: 0,
            salesOrders: 0,
            suratJalan: 0,
            invoices: 0,
            suppliers: 0,
            purchaseOrders: 0,
            operationalExpenses: 0,
            cashInflows: 0,
            employees: 0,
            payrollRecords: 0,
          };

          // 1. Company Profile
          if (payload.company) {
            const comp = payload.company;
            stmts.push(
              env.DB.prepare(
                `INSERT INTO company_profiles (id, name, legal_type, brand_name, is_pkp, npwp, nitku, kpp_name, phone, email, office_address, city, data_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET 
                   name=excluded.name, 
                   brand_name=excluded.brand_name, 
                   npwp=excluded.npwp, 
                   nitku=excluded.nitku,
                   office_address=excluded.office_address, 
                   phone=excluded.phone, 
                   email=excluded.email,
                   data_json=excluded.data_json,
                   updated_at=CURRENT_TIMESTAMP`
              ).bind(
                'default-company',
                comp.name || 'PT. Sawit Jaya Nusantara',
                comp.legalType || 'PT',
                comp.brandName || 'MinyakKu',
                comp.isPkp ? 1 : 0,
                comp.npwp || '',
                comp.nitku || '',
                comp.kppName || '',
                comp.phone || '',
                comp.email || '',
                comp.officeAddress || '',
                comp.city || '',
                JSON.stringify(comp)
              )
            );
            savedStats.company = 1;
          }

          // 2. Customers
          if (Array.isArray(payload.customers)) {
            for (const c of payload.customers) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO customers (id, code, name, company_name, tier, phone, email, address, city, is_pkp, npwp, nik, credit_limit, current_receivable, payment_terms, notes, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                   ON CONFLICT(code) DO UPDATE SET 
                     name=excluded.name, 
                     tier=excluded.tier, 
                     phone=excluded.phone, 
                     address=excluded.address,
                     credit_limit=excluded.credit_limit,
                     current_receivable=excluded.current_receivable,
                     data_json=excluded.data_json`
                ).bind(
                  c.id || c.code,
                  c.code,
                  c.name,
                  c.companyOrShopName || c.companyName || '',
                  c.tier || 'END_USER',
                  c.phone,
                  c.email || '',
                  c.address,
                  c.city || '',
                  c.isPkp ? 1 : 0,
                  c.npwp || '',
                  c.nik || '',
                  Number(c.creditLimit) || 0,
                  Number(c.currentReceivable) || 0,
                  c.paymentTerms || 'CASH_BEFORE_DELIVERY',
                  c.notes || '',
                  JSON.stringify(c)
                )
              );
              savedStats.customers++;
            }
          }

          // 3. Resellers
          if (Array.isArray(payload.resellers)) {
            for (const r of payload.resellers) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO resellers (id, code, name, nik, npwp, shop_name, area, phone, tier_level, commission_rate_pct, credit_limit, balance_owed, status, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                   ON CONFLICT(code) DO UPDATE SET 
                     name=excluded.name, 
                     phone=excluded.phone, 
                     nik=excluded.nik,
                     shop_name=excluded.shop_name,
                     area=excluded.area,
                     tier_level=excluded.tier_level,
                     commission_rate_pct=excluded.commission_rate_pct,
                     data_json=excluded.data_json`
                ).bind(
                  r.id || r.code,
                  r.code,
                  r.name,
                  r.nik || '',
                  r.npwp || '',
                  r.shopName || '',
                  r.area || '',
                  r.phone,
                  r.tierLevel || 'BRONZE',
                  Number(r.commissionRatePct) || 2.5,
                  Number(r.creditLimit) || 10000000,
                  Number(r.balanceOwed) || 0,
                  r.status || 'ACTIVE',
                  JSON.stringify(r)
                )
              );
              savedStats.resellers++;
            }
          }

          // 4. Warehouses
          if (Array.isArray(payload.warehouses)) {
            for (const w of payload.warehouses) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO warehouses (id, code, name, location, address, pic_name, pic_phone, capacity_liters, current_stock_liters, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                   ON CONFLICT(code) DO UPDATE SET 
                     name=excluded.name, 
                     address=excluded.address, 
                     pic_name=excluded.pic_name, 
                     current_stock_liters=excluded.current_stock_liters,
                     data_json=excluded.data_json`
                ).bind(
                  w.id || w.code,
                  w.code || w.id,
                  w.name,
                  w.location || '',
                  w.address || '',
                  w.picName || '',
                  w.picPhone || '',
                  Number(w.capacityLiters) || 100000,
                  Number(w.currentStockLiters) || 0,
                  JSON.stringify(w)
                )
              );
              savedStats.warehouses++;
            }
          }

          // 5. Products
          if (Array.isArray(payload.products)) {
            for (const p of payload.products) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO products (id, code, name, category, packaging_unit, liters_per_unit, hpp_price, price_end_user, price_reseller, price_grosir, min_stock_alert, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                   ON CONFLICT(code) DO UPDATE SET 
                     name=excluded.name, 
                     packaging_unit=excluded.packaging_unit, 
                     hpp_price=excluded.hpp_price, 
                     price_end_user=excluded.price_end_user, 
                     price_reseller=excluded.price_reseller, 
                     price_grosir=excluded.price_grosir,
                     data_json=excluded.data_json`
                ).bind(
                  p.id || p.code,
                  p.code || p.id,
                  p.name,
                  p.category || 'POUCH',
                  p.packagingUnit || 'Karton',
                  Number(p.litersPerUnit) || 1,
                  Number(p.hppPrice) || 0,
                  Number(p.prices?.endUser ?? p.price_end_user ?? 0),
                  Number(p.prices?.reseller ?? p.price_reseller ?? 0),
                  Number(p.prices?.grosir ?? p.price_grosir ?? 0),
                  Number(p.minStockAlert) || 100,
                  JSON.stringify(p)
                )
              );
              savedStats.products++;
            }
          }

          // 6. Stock Batches
          if (Array.isArray(payload.stockBatches)) {
            for (const b of payload.stockBatches) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO stock_batches (id, warehouse_id, product_sku_id, supplier_name, batch_number, expired_date, qty, unit, inbound_date, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                   ON CONFLICT(id) DO UPDATE SET 
                     qty=excluded.qty, 
                     expired_date=excluded.expired_date,
                     data_json=excluded.data_json`
                ).bind(
                  b.id,
                  b.warehouseId,
                  b.productSkuId,
                  b.supplierName || 'Pabrik Minyak Nusantara',
                  b.batchNumber,
                  b.expiredDate || '',
                  Number(b.qty) || 0,
                  b.unit || 'Karton',
                  b.inboundDate || '',
                  JSON.stringify(b)
                )
              );
              savedStats.stockBatches++;
            }
          }

          // 7. Sales Orders
          if (Array.isArray(payload.salesOrders)) {
            for (const o of payload.salesOrders) {
              const subtotal = Number(o.subtotalDpp ?? o.subtotal_dpp ?? o.subtotal ?? 0);
              const ppn = Number(o.ppnAmount ?? o.ppn_amount ?? o.ppn ?? 0);
              const grand = Number(o.grandTotal ?? o.grand_total ?? (subtotal + ppn));
              const uniqueCodeDiscountApplied = Number(
                o.uniqueCodeDiscountApplied ?? o.unique_code_discount_applied ?? 0
              );
              const addedUniqueCode = Number(
                o.addedUniqueCode ?? o.added_unique_code ?? o.paymentUniqueCode ?? o.payment_unique_code ?? 0
              );
              const paymentUniqueCode = Number(
                o.paymentUniqueCode ?? o.payment_unique_code ?? addedUniqueCode
              );
              const explicitUniqueTransfer = Number(o.uniqueTransferAmount ?? o.unique_transfer_amount ?? 0);
              const uniqueTransferAmount =
                explicitUniqueTransfer > 0
                  ? explicitUniqueTransfer
                  : Math.max(0, grand - uniqueCodeDiscountApplied + addedUniqueCode);
              const orderDt = o.date || o.orderDate || new Date().toISOString().split('T')[0];
              const enrichedOrder = {
                ...o,
                subtotalDpp: subtotal,
                ppnAmount: ppn,
                grandTotal: grand,
                paymentUniqueCode,
                uniqueCodeDiscountApplied,
                addedUniqueCode,
                uniqueCollisionResolved: Boolean(o.uniqueCollisionResolved ?? o.unique_collision_resolved ?? false),
                uniqueReasonNote: o.uniqueReasonNote || o.unique_reason_note || '',
                uniqueTransferAmount,
              };

              stmts.push(
                env.DB.prepare(
                  `INSERT INTO sales_orders (id, order_number, order_date, customer_id, customer_name, customer_tier, sales_person, subtotal_dpp, ppn_amount, grand_total, negotiation_status, payment_status, payment_method, dispatch_status, notes, items_json, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                   ON CONFLICT(order_number) DO UPDATE SET 
                     payment_status=excluded.payment_status, 
                     dispatch_status=excluded.dispatch_status,
                     grand_total=excluded.grand_total,
                     items_json=excluded.items_json,
                     data_json=excluded.data_json`
                ).bind(
                  o.id || o.orderNumber,
                  o.orderNumber,
                  orderDt,
                  o.customerId || '',
                  o.customerName || 'Customer',
                  o.customerTier || 'END_USER',
                  o.salesPerson || 'Sales Team',
                  subtotal,
                  ppn,
                  grand,
                  o.negotiationStatus || 'NOT_NEEDED',
                  o.paymentStatus || 'UNPAID',
                  o.paymentMethod || 'MANUAL_TRANSFER',
                  o.dispatchStatus || 'WAITING_PRICE_APPROVAL',
                  o.notes || '',
                  JSON.stringify(o.items || []),
                  JSON.stringify(enrichedOrder)
                )
              );
              insertedOrders++;
              savedStats.salesOrders++;
            }
          }

          // 8. Surat Jalan
          if (Array.isArray(payload.suratJalanList)) {
            for (const sj of payload.suratJalanList) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO surat_jalan (id, sj_number, sales_order_id, sales_order_number, date, customer_name, warehouse_name, driver_name, vehicle_plate_number, status, items_json, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                   ON CONFLICT(sj_number) DO UPDATE SET 
                     status=excluded.status,
                     driver_name=excluded.driver_name,
                     vehicle_plate_number=excluded.vehicle_plate_number,
                     items_json=excluded.items_json,
                     data_json=excluded.data_json`
                ).bind(
                  sj.id || sj.sjNumber,
                  sj.sjNumber,
                  sj.salesOrderId || '',
                  sj.salesOrderNumber || sj.orderNumber || '',
                  sj.date || '',
                  sj.customerName || '',
                  sj.warehouseName || '',
                  sj.driverName || '',
                  sj.vehiclePlateNumber || '',
                  sj.status || 'IN_TRANSIT',
                  JSON.stringify(sj.items || []),
                  JSON.stringify(sj)
                )
              );
              savedStats.suratJalan++;
            }
          }

          // 9. Invoices
          if (Array.isArray(payload.invoices)) {
            for (const inv of payload.invoices) {
              const subtotal = Number(inv.subtotalDpp ?? 0);
              const ppn = Number(inv.ppn11 ?? inv.ppnAmount ?? 0);
              const grand = Number(inv.grandTotal ?? (subtotal + ppn));
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO invoices (id, invoice_number, sales_order_id, order_number, date, due_date, subtotal_dpp, ppn_amount, grand_total, payment_status, faktur_pajak_number, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                   ON CONFLICT(invoice_number) DO UPDATE SET 
                     payment_status=excluded.payment_status,
                     grand_total=excluded.grand_total,
                     faktur_pajak_number=excluded.faktur_pajak_number,
                     data_json=excluded.data_json`
                ).bind(
                  inv.id || inv.invoiceNumber,
                  inv.invoiceNumber,
                  inv.salesOrderId || '',
                  inv.orderNumber || '',
                  inv.date || '',
                  inv.dueDate || '',
                  subtotal,
                  ppn,
                  grand,
                  inv.paymentStatus || 'UNPAID',
                  inv.fakturPajakNumber || '',
                  JSON.stringify(inv)
                )
              );
              savedStats.invoices++;
            }
          }

          // 10. Suppliers
          if (Array.isArray(payload.suppliers)) {
            for (const s of payload.suppliers) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO suppliers (id, code, name, brand_names, is_pkp, npwp, nib, phone, email, pic_name, pic_phone, address, city, payment_terms, status, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                   ON CONFLICT(code) DO UPDATE SET 
                     name=excluded.name,
                     brand_names=excluded.brand_names,
                     npwp=excluded.npwp,
                     phone=excluded.phone,
                     pic_name=excluded.pic_name,
                     data_json=excluded.data_json`
                ).bind(
                  s.id || s.code,
                  s.code,
                  s.name,
                  s.brandNames || '',
                  s.isPkp ? 1 : 0,
                  s.npwp,
                  s.nib || '',
                  s.phone || '',
                  s.email || '',
                  s.picName || '',
                  s.picPhone || '',
                  s.address || '',
                  s.city || '',
                  s.paymentTerms || 'TOP_14',
                  s.status || 'ACTIVE',
                  JSON.stringify(s)
                )
              );
              savedStats.suppliers++;
            }
          }

          // 11. Purchase Orders
          if (Array.isArray(payload.purchaseOrders)) {
            for (const po of payload.purchaseOrders) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO purchase_orders (id, po_number, order_date, expected_delivery_date, supplier_id, supplier_name, supplier_npwp, target_warehouse_id, target_warehouse_name, subtotal_dpp, ppn_amount, pph22_amount, grand_total, payment_status, delivery_status, faktur_pajak_number, faktur_pajak_date, faktur_pajak_file_url, drive_file_id, drive_web_view_link, items_json, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
                   ON CONFLICT(po_number) DO UPDATE SET 
                     payment_status=excluded.payment_status,
                     delivery_status=excluded.delivery_status,
                     faktur_pajak_number=excluded.faktur_pajak_number,
                     faktur_pajak_file_url=excluded.faktur_pajak_file_url,
                     drive_file_id=excluded.drive_file_id,
                     drive_web_view_link=excluded.drive_web_view_link,
                     data_json=excluded.data_json`
                ).bind(
                  po.id || po.poNumber,
                  po.poNumber,
                  po.orderDate || '',
                  po.expectedDeliveryDate || '',
                  po.supplierId || '',
                  po.supplierName || '',
                  po.supplierNpwp || '',
                  po.targetWarehouseId || '',
                  po.targetWarehouseName || '',
                  Number(po.subtotalDpp) || 0,
                  Number(po.ppnAmount) || 0,
                  Number(po.pph22Amount) || 0,
                  Number(po.grandTotal) || 0,
                  po.paymentStatus || 'UNPAID',
                  po.deliveryStatus || 'ORDERED',
                  po.fakturPajakNumber || '',
                  po.fakturPajakDate || '',
                  po.fakturPajakFileUrl || '',
                  po.fakturPajakDriveFileId || '',
                  po.fakturPajakDriveWebViewLink || '',
                  JSON.stringify(po.items || []),
                  JSON.stringify(po)
                )
              );
              savedStats.purchaseOrders++;
            }
          }

          // 12. Operational Expenses
          if (Array.isArray(payload.operationalExpenses)) {
            for (const exp of payload.operationalExpenses) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO operational_expenses (id, expense_date, category, description, amount, payment_account, reference_number, warehouse_name, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                   ON CONFLICT(id) DO UPDATE SET
                     expense_date=excluded.expense_date,
                     category=excluded.category,
                     description=excluded.description,
                     amount=excluded.amount,
                     payment_account=excluded.payment_account,
                     data_json=excluded.data_json`
                ).bind(
                  exp.id,
                  exp.date || '',
                  exp.category || 'LAINNYA',
                  exp.description || '',
                  Number(exp.amount) || 0,
                  exp.paymentAccount || '',
                  exp.referenceNumber || '',
                  exp.warehouseName || '',
                  JSON.stringify(exp)
                )
              );
              savedStats.operationalExpenses++;
            }
          }

          // 13. Cash Inflows & Loans
          if (Array.isArray(payload.cashInflows)) {
            for (const ci of payload.cashInflows) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO cash_inflows (id, inflow_date, inflow_type, source_name, description, principal_amount, tenor_months, annual_interest_rate_pct, interest_tax_rate_pct, paid_installments, destination_account, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                   ON CONFLICT(id) DO UPDATE SET
                     inflow_date=excluded.inflow_date,
                     inflow_type=excluded.inflow_type,
                     source_name=excluded.source_name,
                     description=excluded.description,
                     principal_amount=excluded.principal_amount,
                     paid_installments=excluded.paid_installments,
                     data_json=excluded.data_json`
                ).bind(
                  ci.id,
                  ci.date || '',
                  ci.type || 'PINJAMAN_PEMILIK_PT',
                  ci.sourceName || '',
                  ci.description || '',
                  Number(ci.principalAmount) || 0,
                  Number(ci.tenorMonths) || 0,
                  Number(ci.annualInterestRatePct) || 0,
                  Number(ci.interestTaxRatePct) || 15,
                  Number(ci.paidInstallments) || 0,
                  ci.destinationAccount || '',
                  JSON.stringify(ci)
                )
              );
              savedStats.cashInflows++;
            }
          }

          // 14. Employees (termasuk penghapusan & sinkronisasi ID berurutan)
          if (payload.replaceEmployees === true && Array.isArray(payload.employees)) {
            stmts.push(env.DB.prepare('DELETE FROM employees'));
          } else if (Array.isArray(payload.deletedEmployeeIds) && payload.deletedEmployeeIds.length > 0) {
            for (const delId of payload.deletedEmployeeIds) {
              const cleanDelId = String(delId || '').trim();
              if (cleanDelId) {
                stmts.push(env.DB.prepare('DELETE FROM employees WHERE id = ?1').bind(cleanDelId));
              }
            }
          }

          if (Array.isArray(payload.employees)) {
            for (const emp of payload.employees) {
              const empId = emp.id || emp.code;
              if (emp.code) {
                stmts.push(
                  env.DB.prepare('DELETE FROM employees WHERE code = ?1 AND id != ?2').bind(
                    emp.code,
                    empId
                  )
                );
              }
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO employees (id, code, name, role_title, department, payroll_scheme, ptkp_status, npwp_or_nik, base_salary, fixed_allowance, status, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                   ON CONFLICT(id) DO UPDATE SET
                     code=excluded.code,
                     name=excluded.name,
                     role_title=excluded.role_title,
                     department=excluded.department,
                     payroll_scheme=excluded.payroll_scheme,
                     ptkp_status=excluded.ptkp_status,
                     npwp_or_nik=excluded.npwp_or_nik,
                     base_salary=excluded.base_salary,
                     fixed_allowance=excluded.fixed_allowance,
                     status=excluded.status,
                     data_json=excluded.data_json`
                ).bind(
                  empId,
                  emp.code,
                  emp.name || '',
                  emp.roleTitle || '',
                  emp.department || '',
                  emp.payrollScheme || 'BULANAN_UMR',
                  emp.ptkpStatus || 'TK/0',
                  emp.npwpOrNik || '',
                  Number(emp.baseSalary) || 0,
                  Number(emp.fixedAllowance) || 0,
                  emp.status || 'ACTIVE',
                  JSON.stringify(emp)
                )
              );
              savedStats.employees++;
            }
          }

          // 15. Payroll Records
          if (Array.isArray(payload.payrollRecords)) {
            for (const pr of payload.payrollRecords) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO payroll_records (id, period_month, pay_date, employee_id, employee_name, payroll_scheme, gross_pay, pph21_amount, net_take_home_pay, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                   ON CONFLICT(id) DO UPDATE SET
                     gross_pay=excluded.gross_pay,
                     pph21_amount=excluded.pph21_amount,
                     net_take_home_pay=excluded.net_take_home_pay,
                     data_json=excluded.data_json`
                ).bind(
                  pr.id,
                  pr.periodMonth || '',
                  pr.payDate || '',
                  pr.employeeId || '',
                  pr.employeeName || '',
                  pr.payrollScheme || 'BULANAN_UMR',
                  Number(pr.grossPay) || 0,
                  Number(pr.pph21Amount) || 0,
                  Number(pr.netTakeHomePay) || 0,
                  JSON.stringify(pr)
                )
              );
              savedStats.payrollRecords++;
            }
          }

          if (stmts.length > 0) {
            await env.DB.batch(stmts);
          }

          return Response.json({
            success: true,
            database: 'Cloudflare D1 SQLite (5GB Gratis)',
            message: `Seluruh 15 tabel berhasil disinkronkan ke Cloudflare D1! (${savedStats.salesOrders} pesanan penjualan, ${savedStats.purchaseOrders} PO suplier, ${savedStats.invoices} faktur, ${savedStats.employees} karyawan, ${savedStats.payrollRecords} slip gaji)`,
            stats: savedStats,
            timestamp: new Date().toISOString()
          }, { headers: corsHeaders });
        }

        // B. JIKA MENGGUNAKAN AIVEN POSTGRESQL (FALLBACK)
        const client = getDbClient(env);
        await client.connect();

        try {
          await client.query(`
            ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255);
            ALTER TABLE surat_jalan ADD COLUMN IF NOT EXISTS sales_order_number VARCHAR(100);
            ALTER TABLE sales_orders ALTER COLUMN subtotal_dpp DROP NOT NULL;
            ALTER TABLE sales_orders ALTER COLUMN subtotal_dpp SET DEFAULT 0;
            ALTER TABLE sales_orders ALTER COLUMN grand_total DROP NOT NULL;
            ALTER TABLE sales_orders ALTER COLUMN grand_total SET DEFAULT 0;
          `);
        } catch (e) {
          console.warn('Auto alter columns note:', e);
        }

        if (Array.isArray(payload.customers)) {
          for (const c of payload.customers) {
            await client.query(
              `INSERT INTO customers (code, name, company_name, tier, phone, email, address, city, is_pkp, npwp, nik)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier;`,
              [c.code, c.name, c.companyName || '', c.tier, c.phone, c.email || '', c.address, c.city || '', !!c.isPkp, c.npwp || '', c.nik || '']
            );
          }
        }

        if (Array.isArray(payload.resellers)) {
          for (const r of payload.resellers) {
            await client.query(
              `INSERT INTO resellers (code, name, nik, npwp, shop_name, area, phone, tier_level, commission_rate_pct)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, nik = EXCLUDED.nik;`,
              [r.code, r.name, r.nik, r.npwp || '', r.shopName || '', r.area || '', r.phone, r.tierLevel || 'BRONZE', r.commissionRatePct || 2.5]
            );
          }
        }

        if (Array.isArray(payload.salesOrders)) {
          for (const o of payload.salesOrders) {
            const subtotal = Number(o.subtotalDpp ?? o.subtotal_dpp ?? o.subtotal ?? 0);
            const ppn = Number(o.ppnAmount ?? o.ppn_amount ?? o.ppn ?? 0);
            const grand = Number(o.grandTotal ?? o.grand_total ?? (subtotal + ppn));
            const orderDt = o.date || o.orderDate || new Date().toISOString().split('T')[0];

            await client.query(
              `INSERT INTO sales_orders (order_number, order_date, customer_name, customer_tier, sales_person, subtotal_dpp, ppn_amount, grand_total, negotiation_status, payment_status, dispatch_status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (order_number) DO UPDATE SET payment_status = EXCLUDED.payment_status, dispatch_status = EXCLUDED.dispatch_status;`,
              [o.orderNumber, orderDt, o.customerName || 'Customer', o.customerTier || 'END_USER', o.salesPerson || 'Sales', subtotal, ppn, grand, o.negotiationStatus || 'NOT_NEEDED', o.paymentStatus || 'UNPAID', o.dispatchStatus || 'WAITING_PRICE_APPROVAL']
            );
            insertedOrders++;
          }
        }

        if (Array.isArray(payload.suratJalanList)) {
          for (const sj of payload.suratJalanList) {
            await client.query(
              `INSERT INTO surat_jalan (sj_number, sales_order_number, date, warehouse_name, driver_name, vehicle_plate_number, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (sj_number) DO UPDATE SET status = EXCLUDED.status;`,
              [sj.sjNumber, sj.salesOrderId || sj.salesOrderNumber || '', sj.date, sj.warehouseName, sj.driverName, sj.vehiclePlateNumber, sj.status || 'IN_TRANSIT']
            );
          }
        }

        await client.end();
        return Response.json({
          success: true,
          database: 'Aiven PostgreSQL',
          message: `Berhasil menyimpan data ke Aiven PostgreSQL! (${insertedOrders} order tersinkron)`,
          timestamp: new Date().toISOString()
        }, { headers: corsHeaders });
      }

      // 4. Tarik Seluruh Data dari Database (D1 atau Aiven)
      if ((pathname === '/api/d1/all' || pathname === '/api/sync/pull') && method === 'GET') {
        if (env.DB) {
          const safeJson = (val: any, fallback: any = null) => {
            if (!val) return fallback;
            if (typeof val === 'object') return val;
            try {
              return JSON.parse(String(val));
            } catch {
              return fallback;
            }
          };

          const normalizeCustomer = (row: any) => {
            const parsed = safeJson(row.data_json, {}) || {};
            const code = parsed.code || row.code || `CUST-BOT-${String(row.id || '').slice(0, 6)}`;
            return {
              ...parsed,
              id: parsed.id || row.id || code,
              code,
              name: row.name || parsed.name || 'Pelanggan Baru',
              companyOrShopName: parsed.companyOrShopName || row.company_name || parsed.companyName || row.name || '',
              tier: row.tier || parsed.tier || 'END_USER',
              phone: row.phone || parsed.phone || '-',
              email: row.email ?? parsed.email ?? '',
              address: row.address || parsed.address || '-',
              city: row.city ?? parsed.city ?? '',
              isPkp: parsed.isPkp !== undefined ? Boolean(parsed.isPkp) : Boolean(row.is_pkp),
              npwp: row.npwp ?? parsed.npwp ?? '',
              nik: row.nik ?? parsed.nik ?? '',
              creditLimit: Number(parsed.creditLimit ?? row.credit_limit ?? 0),
              currentReceivable: Number(parsed.currentReceivable ?? row.current_receivable ?? 0),
              paymentTerms: row.payment_terms || parsed.paymentTerms || 'CASH_BEFORE_DELIVERY',
              uniqueCodeCreditBalance: Number(parsed.uniqueCodeCreditBalance ?? 0),
              bankAccounts: Array.isArray(parsed.bankAccounts) ? parsed.bankAccounts : [],
              notes: row.notes ?? parsed.notes ?? 'Tersinkron dari Cloudflare D1',
              createdAt: parsed.createdAt || (row.created_at ? String(row.created_at).slice(0, 10) : new Date().toISOString().split('T')[0]),
            };
          };

          const normalizeOrderItem = (item: any) => {
            if (!item || typeof item !== 'object') return item;
            const quantity = Number(item.quantity ?? item.qty ?? 0);
            const negotiatedUnitPrice = Number(item.negotiatedUnitPrice ?? item.unitPrice ?? item.unit_price ?? item.price ?? 0);
            const standardUnitPrice = Number(item.standardUnitPrice ?? item.standard_unit_price ?? negotiatedUnitPrice);
            const discountAmount = Number(item.discountAmount ?? item.discount_amount ?? Math.max(0, (standardUnitPrice - negotiatedUnitPrice) * quantity));
            const totalPrice = Number(item.totalPrice ?? item.total_price ?? item.subtotal ?? negotiatedUnitPrice * quantity);
            return {
              productSkuId: item.productSkuId || item.product_sku_id || item.productCode || item.product_code || 'sku-1',
              productName: item.productName || item.product_name || 'Minyak Goreng',
              quantity,
              unit: item.unit || 'Karton',
              standardUnitPrice,
              negotiatedUnitPrice,
              discountAmount,
              totalPrice,
            };
          };

          const normalizeReseller = (row: any) => {
            const parsed = safeJson(row.data_json, {}) || {};
            const code = parsed.code || row.code || `RSL-BOT-${String(row.id || '').slice(0, 6)}`;
            const name = row.name || parsed.name || 'Mitra Reseller';
            return {
              ...parsed,
              id: parsed.id || row.id || code,
              code,
              name,
              nik: row.nik ?? parsed.nik ?? '',
              npwp: row.npwp ?? parsed.npwp ?? '',
              shopName: parsed.shopName || row.shop_name || name,
              area: row.area || parsed.area || 'Jakarta Utara',
              address: parsed.address || row.area || parsed.area || '-',
              phone: row.phone || parsed.phone || '-',
              tierLevel: parsed.tierLevel || row.tier_level || 'BRONZE',
              targetMonthlyVolumeCtn: Number(parsed.targetMonthlyVolumeCtn ?? 250),
              currentMonthVolumeCtn: Number(parsed.currentMonthVolumeCtn ?? 0),
              commissionRatePct: Number(parsed.commissionRatePct ?? row.commission_rate_pct ?? 2.5),
              creditLimit: Number(parsed.creditLimit ?? row.credit_limit ?? 10000000),
              balanceOwed: Number(parsed.balanceOwed ?? row.balance_owed ?? 0),
              status: row.status || parsed.status || 'ACTIVE',
              bankAccount:
                parsed.bankAccount && typeof parsed.bankAccount === 'object'
                  ? parsed.bankAccount
                  : { bank: 'BCA', accountNumber: '', holderName: name },
              joinDate:
                parsed.joinDate ||
                (parsed.createdAt ? String(parsed.createdAt).slice(0, 10) : null) ||
                (row.created_at ? String(row.created_at).slice(0, 10) : new Date().toISOString().split('T')[0]),
            };
          };

          const normalizeOrder = (row: any) => {
            const parsed = safeJson(row.data_json, {}) || {};
            const parsedItems = safeJson(row.items_json, null);
            const rawItems = Array.isArray(parsed.items)
              ? parsed.items
              : Array.isArray(parsedItems)
              ? parsedItems
              : [];
            const items = rawItems.map(normalizeOrderItem);
            const subtotalDpp = Number(parsed.subtotalDpp ?? row.subtotal_dpp ?? 0);
            const ppnAmount = Number(parsed.ppnAmount ?? row.ppn_amount ?? 0);
            const grandTotal = Number(parsed.grandTotal ?? row.grand_total ?? subtotalDpp + ppnAmount);
            const uniqueCodeDiscountApplied = Number(
              parsed.uniqueCodeDiscountApplied ?? row.unique_code_discount_applied ?? 0
            );
            const addedUniqueCode = Number(
              parsed.addedUniqueCode ??
                row.added_unique_code ??
                parsed.paymentUniqueCode ??
                row.payment_unique_code ??
                0
            );
            const paymentUniqueCode = Number(
              parsed.paymentUniqueCode ?? row.payment_unique_code ?? addedUniqueCode
            );
            const explicitUnique = Number(parsed.uniqueTransferAmount ?? row.unique_transfer_amount ?? 0);
            const uniqueTransferAmount =
              explicitUnique > 0
                ? explicitUnique
                : Math.max(0, grandTotal - uniqueCodeDiscountApplied + addedUniqueCode);
            const orderDate =
              parsed.date ||
              row.order_date ||
              (row.created_at ? String(row.created_at).slice(0, 10) : new Date().toISOString().split('T')[0]);
            const orderNumber = parsed.orderNumber || row.order_number || `SO-D1-${String(row.id || '').slice(0, 8)}`;

            return {
              ...parsed,
              id: parsed.id || row.id || orderNumber,
              orderNumber,
              date: orderDate,
              customerId: parsed.customerId || row.customer_id || '',
              customerName: row.customer_name || parsed.customerName || 'Pelanggan Chatbot',
              customerTier: row.customer_tier || parsed.customerTier || 'END_USER',
              customerPhone: parsed.customerPhone || row.customer_phone || '-',
              shippingAddress: parsed.shippingAddress || row.shipping_address || '-',
              warehouseId: parsed.warehouseId || row.warehouse_id || '',
              warehouseName: parsed.warehouseName || row.warehouse_name || 'Gudang Utama',
              salesPerson: row.sales_person || parsed.salesPerson || 'Chatbot / D1',
              items,
              subtotalDpp,
              isPkpApplied: parsed.isPkpApplied !== undefined ? Boolean(parsed.isPkpApplied) : ppnAmount > 0,
              ppnAmount,
              pph22Amount: Number(parsed.pph22Amount ?? 0),
              grandTotal,
              paymentUniqueCode,
              uniqueCodeDiscountApplied,
              addedUniqueCode,
              uniqueCollisionResolved: Boolean(
                parsed.uniqueCollisionResolved ?? row.unique_collision_resolved ?? false
              ),
              uniqueReasonNote: parsed.uniqueReasonNote || row.unique_reason_note || '',
              uniqueTransferAmount,
              negotiationStatus: row.negotiation_status || parsed.negotiationStatus || 'NOT_NEEDED',
              negotiationLogs: Array.isArray(parsed.negotiationLogs) ? parsed.negotiationLogs : [],
              paymentStatus: row.payment_status || parsed.paymentStatus || 'UNPAID',
              paymentMethod: row.payment_method || parsed.paymentMethod || 'MANUAL_TRANSFER',
              dispatchStatus: row.dispatch_status || parsed.dispatchStatus || 'READY_TO_DISPATCH',
              notes: row.notes ?? parsed.notes ?? '',
            };
          };

          const companyRes = (await env.DB.prepare('SELECT * FROM company_profiles LIMIT 1').all()).results || [];
          const customers = (await env.DB.prepare('SELECT * FROM customers ORDER BY created_at DESC').all()).results || [];
          const resellers = (await env.DB.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all()).results || [];
          const warehouses = (await env.DB.prepare('SELECT * FROM warehouses ORDER BY created_at ASC').all()).results || [];
          const products = (await env.DB.prepare('SELECT * FROM products ORDER BY created_at ASC').all()).results || [];
          const stockBatches = (await env.DB.prepare('SELECT * FROM stock_batches ORDER BY created_at DESC').all()).results || [];
          const salesOrders = (await env.DB.prepare('SELECT * FROM sales_orders ORDER BY created_at DESC').all()).results || [];
          const suratJalanList = (await env.DB.prepare('SELECT * FROM surat_jalan ORDER BY created_at DESC').all()).results || [];
          const invoices = (await env.DB.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all()).results || [];
          let suppliers: any[] = [];
          let purchaseOrders: any[] = [];
          let operationalExpenses: any[] = [];
          let cashInflows: any[] = [];
          let employees: any[] = [];
          let payrollRecords: any[] = [];
          try {
            suppliers = (await env.DB.prepare('SELECT * FROM suppliers ORDER BY created_at ASC').all()).results || [];
            purchaseOrders = (await env.DB.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all()).results || [];
            operationalExpenses = (await env.DB.prepare('SELECT * FROM operational_expenses ORDER BY expense_date DESC').all()).results || [];
            cashInflows = (await env.DB.prepare('SELECT * FROM cash_inflows ORDER BY inflow_date DESC').all()).results || [];
            employees = (await env.DB.prepare('SELECT * FROM employees ORDER BY created_at ASC').all()).results || [];
            payrollRecords = (await env.DB.prepare('SELECT * FROM payroll_records ORDER BY pay_date DESC').all()).results || [];
          } catch {
            // Tabel opsional belum di-init, abaikan agar tetap kompatibel
          }

          return Response.json({
            success: true,
            database: 'Cloudflare D1 SQLite (5GB Gratis)',
            timestamp: new Date().toISOString(),
            data: {
              company: companyRes[0]?.data_json ? safeJson(companyRes[0].data_json, companyRes[0]) : companyRes[0] || null,
              customers: customers.map(normalizeCustomer),
              resellers: resellers.map(normalizeReseller),
              warehouses: warehouses.map((w: any) => safeJson(w.data_json, w)),
              products: products.map((p: any) => safeJson(p.data_json, p)),
              stockBatches: stockBatches.map((b: any) => safeJson(b.data_json, b)),
              salesOrders: salesOrders.map(normalizeOrder),
              suratJalanList: suratJalanList.map((sj: any) => safeJson(sj.data_json, sj)),
              invoices: invoices.map((inv: any) => safeJson(inv.data_json, inv)),
              suppliers: suppliers.map((s: any) => safeJson(s.data_json, s)),
              purchaseOrders: purchaseOrders.map((po: any) => safeJson(po.data_json, po)),
              operationalExpenses: operationalExpenses.map((e: any) => safeJson(e.data_json, e)),
              cashInflows: cashInflows.map((ci: any) => safeJson(ci.data_json, ci)),
              employees: employees.map((emp: any) => safeJson(emp.data_json, emp)),
              payrollRecords: payrollRecords.map((pr: any) => safeJson(pr.data_json, pr)),
            }
          }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
        }

        if (env.HYPERDRIVE || env.DATABASE_URL) {
          const client = getDbClient(env);
          await client.connect();
          const customers = (await client.query('SELECT * FROM customers ORDER BY created_at DESC LIMIT 200')).rows;
          const resellers = (await client.query('SELECT * FROM resellers ORDER BY created_at DESC LIMIT 200')).rows;
          const salesOrders = (await client.query('SELECT * FROM sales_orders ORDER BY created_at DESC LIMIT 200')).rows;
          const suratJalanList = (await client.query('SELECT * FROM surat_jalan ORDER BY created_at DESC LIMIT 200')).rows;
          await client.end();

          return Response.json({
            success: true,
            database: 'Aiven PostgreSQL',
            data: {
              customers,
              resellers,
              salesOrders,
              suratJalanList,
            }
          }, { headers: corsHeaders });
        }

        return Response.json({ success: false, message: 'Database belum terkonfigurasi' }, { status: 400, headers: corsHeaders });
      }

      // 4B. Real-Time Cek Status Pembayaran & Verifikasi Mutasi Bank via Kode Unik 3-Digit
      if (pathname === '/api/payments/check' && method === 'GET') {
        if (!env.DB) {
          return Response.json({ success: false, found: false, message: 'Cloudflare D1 belum terhubung.' }, { status: 400, headers: corsHeaders });
        }
        const amountParam = Math.round(Number(url.searchParams.get('amount') || 0));
        const codeParam = Math.round(Number(url.searchParams.get('code') || 0));
        const orderNumberParam = (url.searchParams.get('orderNumber') || '').trim();

        const rows = (await env.DB.prepare('SELECT * FROM sales_orders ORDER BY created_at DESC LIMIT 200').all()).results || [];
        const candidates = rows.map((row: any) => {
          let parsed: any = {};
          try { parsed = row.data_json ? JSON.parse(String(row.data_json)) : {}; } catch {}
          const grandTotal = Number(parsed.grandTotal ?? row.grand_total ?? 0);
          const uniqueCodeDiscountApplied = Number(parsed.uniqueCodeDiscountApplied ?? 0);
          const addedUniqueCode = Number(parsed.addedUniqueCode ?? parsed.paymentUniqueCode ?? row.payment_unique_code ?? 0);
          const paymentUniqueCode = Number(parsed.paymentUniqueCode ?? row.payment_unique_code ?? addedUniqueCode);
          const uniqueTransferAmount = Number(
            parsed.uniqueTransferAmount ??
              row.unique_transfer_amount ??
              Math.max(0, grandTotal - uniqueCodeDiscountApplied + addedUniqueCode)
          );
          return {
            ...parsed,
            id: parsed.id || row.id || row.order_number,
            orderNumber: parsed.orderNumber || row.order_number,
            customerId: parsed.customerId || row.customer_id || '',
            customerName: row.customer_name || parsed.customerName || 'Pelanggan',
            subtotalDpp: Number(parsed.subtotalDpp ?? row.subtotal_dpp ?? 0),
            ppnAmount: Number(parsed.ppnAmount ?? row.ppn_amount ?? 0),
            grandTotal,
            uniqueCodeDiscountApplied,
            addedUniqueCode,
            paymentUniqueCode,
            uniqueTransferAmount,
            paymentStatus: row.payment_status || parsed.paymentStatus || 'UNPAID',
            date: parsed.date || row.order_date || '',
          };
        });

        let matched: any = null;
        if (orderNumberParam) {
          matched = candidates.find((c: any) => String(c.orderNumber).toLowerCase() === orderNumberParam.toLowerCase());
        }
        if (!matched && amountParam > 0) {
          matched =
            candidates.find((c: any) => Math.round(c.uniqueTransferAmount) === amountParam) ||
            candidates.find((c: any) => c.paymentStatus !== 'PAID' && Math.round(c.grandTotal) === amountParam);
        }
        if (!matched && codeParam >= 100 && codeParam <= 999) {
          matched =
            candidates.find(
              (c: any) =>
                c.paymentStatus !== 'PAID' &&
                (Math.round(c.uniqueTransferAmount) % 1000 === codeParam ||
                  Number(c.addedUniqueCode) === codeParam ||
                  Number(c.paymentUniqueCode) === codeParam)
            ) ||
            candidates.find(
              (c: any) =>
                Math.round(c.uniqueTransferAmount) % 1000 === codeParam ||
                Number(c.addedUniqueCode) === codeParam ||
                Number(c.paymentUniqueCode) === codeParam
            );
        }

        if (!matched) {
          return Response.json({
            success: true,
            found: false,
            message: 'Tidak ada pesanan D1 yang cocok dengan nominal transfer / kode unik tersebut.',
          }, { headers: corsHeaders });
        }

        return Response.json({
          success: true,
          found: true,
          order: matched,
          isPaid: matched.paymentStatus === 'PAID',
          message:
            matched.paymentStatus === 'PAID'
              ? `Order ${matched.orderNumber} (${matched.customerName}) SUDAH LUNAS.`
              : `Order ${matched.orderNumber} (${matched.customerName}) ditemukan dengan status ${matched.paymentStatus}. Wajib transfer tepat Rp ${matched.uniqueTransferAmount.toLocaleString('id-ID')}${matched.uniqueCodeDiscountApplied > 0 ? ` (Diskon Saldo −Rp ${matched.uniqueCodeDiscountApplied.toLocaleString('id-ID')})` : ''}${matched.addedUniqueCode > 0 ? ` (Kode Unik +${matched.addedUniqueCode})` : ''}.`,
        }, { headers: corsHeaders });
      }

      if (pathname === '/api/payments/verify-mutation' && method === 'POST') {
        if (!env.DB) {
          return Response.json({ success: false, matched: false, message: 'Cloudflare D1 belum terhubung.' }, { status: 400, headers: corsHeaders });
        }
        const body: any = await request.json().catch(() => ({}));
        const amountParam = Math.round(Number(body.amount || 0));
        const codeParam = Math.round(Number(body.code || (amountParam >= 100 && amountParam <= 999 ? amountParam : 0)));
        const orderNumberParam = String(body.orderNumber || '').trim();
        const autoMarkPaid = body.autoMarkPaid !== false;

        const rows = (await env.DB.prepare('SELECT * FROM sales_orders ORDER BY created_at DESC LIMIT 200').all()).results || [];
        let targetRow: any = null;
        let targetParsed: any = {};

        for (const row of rows) {
          if (row.payment_status === 'CANCELLED') continue;
          let parsed: any = {};
          try { parsed = row.data_json ? JSON.parse(String(row.data_json)) : {}; } catch {}
          const grandTotal = Number(parsed.grandTotal ?? row.grand_total ?? 0);
          const uniqueDiscount = Number(parsed.uniqueCodeDiscountApplied ?? 0);
          const addedUnique = Number(parsed.addedUniqueCode ?? parsed.paymentUniqueCode ?? row.payment_unique_code ?? 0);
          const uniqueCode = Number(parsed.paymentUniqueCode ?? row.payment_unique_code ?? addedUnique);
          const uniqueTransfer = Number(
            parsed.uniqueTransferAmount ??
              row.unique_transfer_amount ??
              Math.max(0, grandTotal - uniqueDiscount + addedUnique)
          );
          const ordNum = parsed.orderNumber || row.order_number;

          const baseTarget = {
            ...parsed,
            grandTotal,
            uniqueCodeDiscountApplied: uniqueDiscount,
            addedUniqueCode: addedUnique,
            paymentUniqueCode: uniqueCode,
            uniqueTransferAmount: uniqueTransfer,
            orderNumber: ordNum,
            customerId: parsed.customerId || row.customer_id || '',
          };

          if (orderNumberParam && String(ordNum).toLowerCase() === orderNumberParam.toLowerCase()) {
            targetRow = row;
            targetParsed = baseTarget;
            break;
          }
          if (amountParam > 999 && Math.round(uniqueTransfer) === amountParam) {
            targetRow = row;
            targetParsed = baseTarget;
            break;
          }
          if (
            codeParam >= 100 &&
            codeParam <= 999 &&
            row.payment_status !== 'PAID' &&
            (Math.round(uniqueTransfer) % 1000 === codeParam || addedUnique === codeParam || uniqueCode === codeParam)
          ) {
            targetRow = row;
            targetParsed = baseTarget;
            break;
          }
        }

        if (!targetRow) {
          return Response.json({
            success: true,
            matched: false,
            message: 'Mutasi transfer belum cocok dengan tagihan kode unik aktif di D1.',
          }, { headers: corsHeaders });
        }

        if (autoMarkPaid && targetRow.payment_status !== 'PAID') {
          const updatedJson = JSON.stringify({
            ...targetParsed,
            paymentStatus: 'PAID',
            paymentVerifiedAt: new Date().toISOString(),
            paymentVerificationBank: body.bank || 'Mutasi Bank Otomatis',
            paymentReferenceNumber: body.referenceNumber || `MUT-${Date.now().toString().slice(-6)}`,
          });

          await env.DB.batch([
            env.DB.prepare(
              `UPDATE sales_orders SET payment_status = 'PAID', data_json = ?1 WHERE order_number = ?2`
            ).bind(updatedJson, targetParsed.orderNumber),
            env.DB.prepare(
              `UPDATE invoices SET payment_status = 'PAID' WHERE order_number = ?1`
            ).bind(targetParsed.orderNumber),
          ]);

          // Recalculate and update buyer's uniqueCodeCreditBalance in D1 customers table
          if (targetParsed.customerId) {
            try {
              const custRow: any = await env.DB.prepare('SELECT * FROM customers WHERE id = ?1 LIMIT 1')
                .bind(targetParsed.customerId)
                .first();
              if (custRow) {
                const paidRows =
                  (await env.DB.prepare(
                    `SELECT grand_total, payment_unique_code, unique_transfer_amount, data_json FROM sales_orders WHERE customer_id = ?1 AND payment_status = 'PAID'`
                  )
                    .bind(targetParsed.customerId)
                    .all()).results || [];
                let netBalance = 0;
                for (const po of paidRows) {
                  let pJson: any = {};
                  try { pJson = po.data_json ? JSON.parse(String(po.data_json)) : {}; } catch {}
                  const gTotal = Number(pJson.grandTotal ?? po.grand_total ?? 0);
                  const disc = Number(pJson.uniqueCodeDiscountApplied ?? 0);
                  const add = Number(pJson.addedUniqueCode ?? pJson.paymentUniqueCode ?? po.payment_unique_code ?? 0);
                  const uAmt = Number(pJson.uniqueTransferAmount ?? po.unique_transfer_amount ?? Math.max(0, gTotal - disc + add));
                  netBalance += (uAmt - gTotal);
                }
                let prevCustJson: any = {};
                try { prevCustJson = custRow.data_json ? JSON.parse(String(custRow.data_json)) : {}; } catch {}
                const newCustJson = JSON.stringify({
                  ...prevCustJson,
                  uniqueCodeCreditBalance: Math.max(0, Math.round(netBalance)),
                });
                await env.DB.prepare('UPDATE customers SET data_json = ?1 WHERE id = ?2')
                  .bind(newCustJson, targetParsed.customerId)
                  .run();
              }
            } catch (e) {
              console.warn('Update customer uniqueCodeCreditBalance warn:', e);
            }
          }
        }

        return Response.json({
          success: true,
          matched: true,
          order: {
            ...targetParsed,
            id: targetParsed.id || targetRow.id || targetParsed.orderNumber,
            customerName: targetRow.customer_name || targetParsed.customerName || 'Pelanggan',
            paymentStatus: autoMarkPaid ? 'PAID' : targetRow.payment_status,
          },
          message: autoMarkPaid
            ? `LUNAS REAL-TIME: Pesanan ${targetParsed.orderNumber} cocok (Transfer Rp ${targetParsed.uniqueTransferAmount.toLocaleString('id-ID')}) dan status D1 + saldo angka unik customer langsung diupdate!`
            : `Cocok dengan pesanan ${targetParsed.orderNumber} (Transfer Rp ${targetParsed.uniqueTransferAmount.toLocaleString('id-ID')}).`,
        }, { headers: corsHeaders });
      }

      // 5. SiPajak PJAP Resmi DJP (Host-to-Host Coretax Proxy)
      if (pathname.startsWith('/api/sipajak/')) {
        const envMode = (env.SIPAJAK_ENV || 'staging').toLowerCase() === 'production' ? 'production' : 'staging';
        const baseUrl =
          envMode === 'production'
            ? 'https://gateway-integration.sipajak.com'
            : 'https://staging-gateway-integration.sipajak.com';
        const username = env.SIPAJAK_USERNAME || '';
        const password = env.SIPAJAK_PASSWORD || '';

        if (pathname === '/api/sipajak/status' && method === 'GET') {
          const npwp = (env.SIPAJAK_NPWP || '').replace(/[^0-9]/g, '');
          return Response.json({
            configured: Boolean(username && password && npwp),
            environment: envMode,
            baseUrl,
            npwp,
          }, { headers: corsHeaders });
        }

        const body: any = method === 'POST' ? await request.json().catch(() => ({})) : {};
        const npwp = (env.SIPAJAK_NPWP || body?.sellerNpwp || '').replace(/[^0-9]/g, '');
        if (!username || !password || !npwp) {
          return Response.json({
            success: false,
            configured: false,
            status: 'NOT_CONFIGURED',
            valid: false,
            message: 'Kredensial Worker SiPajak belum diset (wrangler secret put SIPAJAK_USERNAME / SIPAJAK_PASSWORD / SIPAJAK_NPWP). Daftar di https://www.sipajak.com/#harga.',
          }, { headers: corsHeaders });
        }

        const spHeaders = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
          npwp,
        };

        if (pathname === '/api/sipajak/efaktur/create' && method === 'POST') {
          const upstream = await fetch(`${baseUrl}/v2/efaktur/create-faktur-pk`, {
            method: 'POST',
            headers: spHeaders,
            body: JSON.stringify(body.payload || {}),
          });
          const parsed: any = await upstream.json().catch(() => ({}));
          const ok = upstream.ok && (String(parsed?.data?.status ?? '') === '1' || parsed?.success === true);
          return Response.json({
            success: ok,
            configured: true,
            status: ok ? (envMode === 'production' ? 'APPROVED_DJP' : 'STAGING_SENT') : 'REJECTED_DJP',
            fakturPajakNumber: parsed?.data?.nomorFaktur || body?.payload?.nomorFaktur,
            uuid: parsed?.data?.uuid || parsed?.data?.id,
            message: parsed?.data?.statusMessage || parsed?.message || (ok ? 'Terkirim ke SiPajak.' : `HTTP ${upstream.status}`),
            rawResponse: parsed,
          }, { headers: corsHeaders });
        }

        if (pathname === '/api/sipajak/vswp' && method === 'POST') {
          const upstream = await fetch(`${baseUrl}/v2/vswp`, {
            method: 'POST',
            headers: spHeaders,
            body: JSON.stringify({ npwp: body.targetNpwpOrNik || '' }),
          });
          const parsed: any = await upstream.json().catch(() => ({}));
          const ok = upstream.ok && String(parsed?.data?.status ?? '0') === '1';
          return Response.json({
            success: ok,
            configured: true,
            valid: ok,
            name: parsed?.data?.nama || parsed?.data?.name,
            statusWp: parsed?.data?.statusWp || parsed?.data?.statusMessage,
            message: parsed?.data?.statusMessage || (ok ? 'NPWP/NIK valid di DJP.' : 'Validasi DJP tidak cocok.'),
          }, { headers: corsHeaders });
        }

        if (pathname === '/api/sipajak/ebupot/create' && method === 'POST') {
          const upstream = await fetch(`${baseUrl}/v2/ebupot/unifikasi/create`, {
            method: 'POST',
            headers: spHeaders,
            body: JSON.stringify(body.bupot || {}),
          });
          const parsed: any = await upstream.json().catch(() => ({}));
          const ok = upstream.ok && String(parsed?.data?.status ?? '0') === '1';
          return Response.json({
            success: ok,
            configured: true,
            bupotNumber: parsed?.data?.noBupot || parsed?.data?.nomorBuktiPotong,
            message: parsed?.data?.statusMessage || parsed?.message || (ok ? 'e-Bupot terkirim.' : 'Gagal membuat e-Bupot.'),
          }, { headers: corsHeaders });
        }

        if (pathname === '/api/sipajak/ebilling/create' && method === 'POST') {
          const upstream = await fetch(`${baseUrl}/v2/ebilling/create`, {
            method: 'POST',
            headers: spHeaders,
            body: JSON.stringify({
              npwp,
              kap: body?.billing?.kap,
              kjs: body?.billing?.kjs,
              masaPajak: body?.billing?.masaPajak,
              tahunPajak: body?.billing?.tahunPajak,
              jumlahBayar: body?.billing?.amount,
              uraian: body?.billing?.description,
            }),
          });
          const parsed: any = await upstream.json().catch(() => ({}));
          if (upstream.ok && (parsed?.data?.idBilling || parsed?.data?.kodeBilling)) {
            return Response.json({
              success: true,
              configured: true,
              billingCode: parsed?.data?.idBilling || parsed?.data?.kodeBilling,
              expiredAt: parsed?.data?.masaAktif || parsed?.data?.expiredAt,
              message: 'ID Billing 15 digit DJP berhasil dibuat via SiPajak.',
            }, { headers: corsHeaders });
          }
          return Response.json({
            success: false,
            configured: true,
            message: parsed?.message || parsed?.data?.statusMessage || `HTTP ${upstream.status}`,
          }, { headers: corsHeaders });
        }
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  }
};
