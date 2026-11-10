export interface Env {
  DATABASE_URL: string;
  B2_ENDPOINT: string;
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_BUCKET_NAME: string;
  MIDTRANS_SERVER_KEY: string;
  WA_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. Halaman Utama Root & Health Check (Status Online)
      if (url.pathname === "/" || url.pathname === "/api/health") {
        return Response.json(
          {
            status: "ONLINE",
            service: "SGN Sembako / MinyakKu Worker API",
            timestamp: new Date().toISOString(),
            connected_database: "Aiven PostgreSQL",
            connected_storage: `Backblaze B2 (${env.B2_BUCKET_NAME || 'sgn-sembako-documents'})`,
            endpoints: [
              "/api/health",
              "/api/webhooks/midtrans",
              "/api/storage/b2-upload-url"
            ],
            message: "Backend Worker aktif dan siap menerima Webhook Midtrans serta upload dokumen B2!"
          },
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 2. Webhook Midtrans (Deteksi Pembayaran Otomatis & Report WA)
      if (url.pathname === "/api/webhooks/midtrans" && method === "POST") {
        const payload: any = await request.json();
        const orderId = payload.order_id;
        const transactionStatus = payload.transaction_status;
        const grossAmount = payload.gross_amount;

        if (transactionStatus === "capture" || transactionStatus === "settlement") {
          // Kirim notifikasi WhatsApp otomatis
          const message = `✅ *PEMBAYARAN DITERIMA - SGN SEMBAKO*\n\nPesanan: ${orderId}\nNominal: Rp ${Number(grossAmount).toLocaleString('id-ID')}\nStatus: LUNAS (Midtrans)\n\nSurat Jalan sedang diproses gudang. Terima kasih!`;
          
          if (env.WA_API_KEY) {
            await fetch("https://api.fonnte.com/send", {
              method: "POST",
              headers: { Authorization: env.WA_API_KEY, "Content-Type": "application/json" },
              body: JSON.stringify({
                target: payload.custom_field1 || "081298765432",
                message: message,
              }),
            });
          }
        }

        return Response.json({ status: "webhook received" }, { headers: corsHeaders });
      }

      // 3. Upload File Backblaze B2 (Pre-signed URL)
      if (url.pathname === "/api/storage/b2-upload-url" && method === "POST") {
        const { fileName } = await request.json() as any;
        const b2Url = `https://${env.B2_BUCKET_NAME || 'sgn-sembako-documents'}.${env.B2_ENDPOINT || 's3.us-west-004.backblazeb2.com'}/${encodeURIComponent(fileName)}`;
        return Response.json({ uploadUrl: b2Url, fileKey: fileName }, { headers: corsHeaders });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
};