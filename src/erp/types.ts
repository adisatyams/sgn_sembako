import type { Env } from '../index';

// Env tambahan untuk modul ERP (Suplier, PO, Faktur Pajak, Pembukuan).
// Variabel B2_ENDPOINT, B2_BUCKET_NAME, WORKER_API_KEY, CORS_ORIGIN sudah ada di Env bawaan.
export interface ErpEnv extends Env {
  B2_KEY_ID?: string; // Application Key ID Backblaze (secret)
  B2_APPLICATION_KEY?: string; // Application Key Backblaze (secret)
  B2_REGION?: string; // opsional, default diambil dari B2_ENDPOINT (mis. us-west-004)
}

export interface RouteContext {
  request: Request;
  env: ErpEnv;
  db: any;
  url: URL;
  method: string;
  id?: string;
  sub?: string;
  sub2?: string;
}
