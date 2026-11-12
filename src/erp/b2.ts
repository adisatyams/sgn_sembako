// Klien minimal Backblaze B2 lewat S3-Compatible API (AWS Signature V4), tanpa SDK.
// Bucket harus PRIVATE: file faktur pajak berisi NPWP, jadi hanya diunduh lewat Worker (butuh API key).
//
// Konfigurasi di Worker:
//   B2_ENDPOINT         (var)    contoh: s3.us-west-004.backblazeb2.com
//   B2_BUCKET_NAME      (var)    nama bucket
//   B2_KEY_ID           (secret) Application Key ID
//   B2_APPLICATION_KEY  (secret) Application Key
import { HttpError } from './util';
import type { ErpEnv } from './types';

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

/** Encoding path S3: tiap segmen di-encode RFC 3986, tanda "/" dipertahankan. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

export interface B2Config {
  host: string;
  region: string;
  bucket: string;
  keyId: string;
  secret: string;
}

export function getB2Config(env: ErpEnv): B2Config {
  const missing: string[] = [];
  if (!env.B2_ENDPOINT) missing.push('B2_ENDPOINT');
  if (!env.B2_BUCKET_NAME) missing.push('B2_BUCKET_NAME');
  if (!env.B2_KEY_ID) missing.push('B2_KEY_ID');
  if (!env.B2_APPLICATION_KEY) missing.push('B2_APPLICATION_KEY');
  if (missing.length) {
    throw new HttpError(503, `Penyimpanan Backblaze belum dikonfigurasi. Variabel belum ada di Worker: ${missing.join(', ')}`);
  }
  const host = String(env.B2_ENDPOINT).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const regionMatch = host.match(/^s3\.([^.]+)\.backblazeb2\.com$/);
  const region = env.B2_REGION || (regionMatch ? regionMatch[1] : '');
  if (!region) {
    throw new HttpError(503, 'B2_ENDPOINT tidak dikenali. Gunakan format s3.<region>.backblazeb2.com atau isi B2_REGION.');
  }
  return { host, region, bucket: String(env.B2_BUCKET_NAME), keyId: String(env.B2_KEY_ID), secret: String(env.B2_APPLICATION_KEY) };
}

/** Membuat header bertanda tangan SigV4 untuk satu request ke B2 (path-style). */
export async function signRequest(
  cfg: B2Config,
  method: string,
  key: string,
  payloadHash: string,
  now: Date = new Date(),
  extraHeaders: Record<string, string> = {}
): Promise<{ url: string; headers: Record<string, string> }> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = encodePath(`/${cfg.bucket}/${key}`);

  const headersToSign: Record<string, string> = {
    host: cfg.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  for (const [k, v] of Object.entries(extraHeaders)) headersToSign[k.toLowerCase()] = v.trim();

  const signedNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headersToSign[n]}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(enc.encode('AWS4' + cfg.secret), dateStamp);
  const kRegion = await hmac(kDate, cfg.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const headers: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  return { url: `https://${cfg.host}${canonicalUri}`, headers };
}

export async function b2Put(env: ErpEnv, key: string, body: ArrayBuffer, contentType: string): Promise<void> {
  const cfg = getB2Config(env);
  const hash = await sha256Hex(body);
  const { url, headers } = await signRequest(cfg, 'PUT', key, hash, new Date(), { 'content-type': contentType });
  const res = await fetch(url, { method: 'PUT', headers, body });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new HttpError(502, `Upload ke Backblaze gagal (HTTP ${res.status})`, text);
  }
}

export async function b2Get(env: ErpEnv, key: string): Promise<Response> {
  const cfg = getB2Config(env);
  const { url, headers } = await signRequest(cfg, 'GET', key, await sha256Hex(''));
  const res = await fetch(url, { method: 'GET', headers });
  if (res.status === 404) throw new HttpError(404, 'File tidak ditemukan di penyimpanan');
  if (!res.ok) throw new HttpError(502, `Gagal mengambil file dari Backblaze (HTTP ${res.status})`);
  return res;
}

export async function b2Delete(env: ErpEnv, key: string): Promise<void> {
  const cfg = getB2Config(env);
  const { url, headers } = await signRequest(cfg, 'DELETE', key, await sha256Hex(''));
  const res = await fetch(url, { method: 'DELETE', headers });
  // 204 sukses, 404 dianggap sudah terhapus
  if (!res.ok && res.status !== 404) throw new HttpError(502, `Gagal menghapus file di Backblaze (HTTP ${res.status})`);
}
