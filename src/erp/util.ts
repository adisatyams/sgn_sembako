export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const uuid = (): string => crypto.randomUUID();

/** Tanggal hari ini (YYYY-MM-DD) dalam zona waktu WIB (UTC+7). */
export function todayJakarta(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function digitsOnly(s: unknown): string {
  return String(s ?? '').replace(/\D/g, '');
}

export function str(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

export function num(v: unknown, field: string, min?: number): number {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) {
    throw new HttpError(422, `${field} harus berupa angka`);
  }
  if (min !== undefined && n < min) throw new HttpError(422, `${field} minimal ${min}`);
  return n;
}

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function reqDate(v: unknown, field: string): string {
  if (!isDate(v)) throw new HttpError(422, `${field} wajib diisi dengan format YYYY-MM-DD`);
  return v;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export async function readJson(request: Request): Promise<any> {
  try {
    const body = await request.json();
    if (body === null || typeof body !== 'object') throw new Error('bukan objek');
    return body;
  } catch {
    throw new HttpError(400, 'Body request harus berupa JSON yang valid');
  }
}

/** Nomor urut atomik per kunci (dipakai untuk nomor dokumen). */
export async function nextSeq(db: any, key: string): Promise<number> {
  const row = await db
    .prepare(
      'INSERT INTO doc_counters(key, last) VALUES(?1, 1) ON CONFLICT(key) DO UPDATE SET last = last + 1 RETURNING last'
    )
    .bind(key)
    .first();
  return Number(row?.last ?? 1);
}

/** Contoh hasil: PO/202611/0001 */
export async function nextDocNumber(db: any, prefix: string, date: string): Promise<string> {
  const ym = date.slice(0, 4) + date.slice(5, 7);
  const seq = await nextSeq(db, `${prefix}-${ym}`);
  return `${prefix}/${ym}/${String(seq).padStart(4, '0')}`;
}

/** Placeholder SQL "?1,?2,?3" untuk klausa IN. */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `?${i + start}`).join(',');
}
