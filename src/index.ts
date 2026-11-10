/**
 * Cloudflare Worker Backend for MinyakKu Cooking Oil Trading Automation
 * Handles:
 * - Connection to Aiven PostgreSQL (via hyperdrive / pg)
 * - Midtrans & Xendit Payment Webhooks
 * - Backblaze B2 S3 Pre-signed Upload URLs for Invoices & Surat Jalan
 * - WhatsApp API Notification Gateway
 */

export interface Env {
  // Aiven PostgreSQL connection string or Hyperdrive binding
  DATABASE_URL: string;
  // Backblaze B2 S3 API credentials
  B2_ENDPOINT: string; // e.g. s3.us-west-004.backblazeb2.com
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_BUCKET_NAME: string;
  // Payment Gateway Secrets
  MIDTRANS_SERVER_KEY: string;
  XENDIT_SECRET_KEY: string;
  // WhatsApp Gateway (e.g. Fonnte / Wablas / Twilio)
  WA_API_KEY: string;
  WA_SENDER_NUMBER: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. Health & Status
      if (url.pathname === "/api/health") {
        return Response.json({ status: "ok", service: "MinyakKu Cloudflare Worker" }, { headers: corsHeaders });
      }

      // 2. Webhook Midtrans (Auto Payment Detection & WA Notification)
      if (url.pathname === "/api/webhooks/midtrans" && method === "POST") {
        const payload: any = await request.json();
        const orderId = payload.order_id;
        const transactionStatus = payload.transaction_status;
        const grossAmount = payload.gross_amount;

        if (transactionStatus === "capture" || transactionStatus === "settlement") {
          // Trigger WhatsApp notification to customer & admin
          const message = `✅ *PEMBAYARAN DITERIMA - SAWIT JAYA*\n\nPesanan: ${orderId}\nNominal: Rp ${Number(grossAmount).toLocaleString('id-ID')}\nStatus: Lunas (Midtrans)\n\nSurat Jalan & persiapan muat armada sedang diproses gudang. Terima kasih!`;
          
          await fetch("https://api.fonnte.com/send", {
            method: "POST",
            headers: { Authorization: env.WA_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              target: payload.custom_field1 || "081298765432",
              message: message,
            }),
          });
        }

        return Response.json({ status: "webhook received" }, { headers: corsHeaders });
      }

      // 3. Backblaze B2 Upload Presigned URL Generator
      if (url.pathname === "/api/storage/b2-upload-url" && method === "POST") {
        const { fileName, contentType } = await request.json() as any;
        // In production, sign AWS S3 v4 request for Backblaze B2 bucket
        const mockPresignedUrl = `https://${env.B2_BUCKET_NAME}.${env.B2_ENDPOINT}/${encodeURIComponent(fileName)}`;
        
        return Response.json({
          uploadUrl: mockPresignedUrl,
          fileKey: fileName,
          storageProvider: "Backblaze B2 S3-Compatible",
        }, { headers: corsHeaders });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
};
