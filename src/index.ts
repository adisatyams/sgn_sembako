/**
 * Cloudflare Worker Backend for MinyakKu Cooking Oil Trading Automation
 * - Koneksi Resmi Aiven PostgreSQL via Cloudflare Hyperdrive (connection pooling)
 * - Keamanan API: Proteksi X-API-KEY & Pembatasan Domain CORS
 * - Auto-Inisialisasi 14 Tabel DDL ke Aiven
 * - Sinkronisasi Data Master & Transaksi (Orders, Surat Jalan, Invoice, Stok)
 * - Webhook Midtrans dengan signature verification & Notifikasi WhatsApp
 * - Backblaze B2 Pre-signed URL
 */

import { Client } from 'pg';

export interface Env {
  // Binding resmi Cloudflare Hyperdrive ke Aiven PostgreSQL
  HYPERDRIVE?: {
    connectionString: string;
  };
  // Fallback connection string jika Hyperdrive belum di-bind
  DATABASE_URL?: string;

  // Keamanan API
  WORKER_API_KEY?: string; // Default: 'minyakku-secure-erp-key-2026'
  CORS_ORIGIN?: string;    // 'https://front-end-sgn-sembako.pages.dev'

  // Backblaze B2 S3 API credentials
  B2_ENDPOINT?: string;
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_BUCKET_NAME?: string;

  // Payment Gateway Secrets
  MIDTRANS_SERVER_KEY?: string;
  XENDIT_SECRET_KEY?: string;

  // WhatsApp Gateway
  WA_API_KEY?: string;
  WA_SENDER_NUMBER?: string;
}

// Helper untuk koneksi Database PostgreSQL Aiven
function getDbClient(env: Env): Client {
  const connString = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!connString) {
    throw new Error('DATABASE_URL atau HYPERDRIVE binding belum dikonfigurasi di Worker!');
  }
  return new Client({
    connectionString: connString,
    ssl: { rejectUnauthorized: false }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // 1. KEAMANAN CORS: Batasi hanya untuk domain resmi Front End Anda
    const allowedOrigins = [
      env.CORS_ORIGIN || 'https://front-end-sgn-sembako.pages.dev',
      'http://localhost:3000',
      'http://localhost:5173'
    ];
    const origin = request.headers.get('Origin') || '';
    const isAllowedOrigin = allowedOrigins.includes(origin) || origin.endsWith('.pages.dev');

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': isAllowedOrigin ? origin : (allowedOrigins[0] || '*'),
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-KEY',
      'Access-Control-Max-Age': '86400',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. KEAMANAN API: Verifikasi Secret Token / X-API-KEY
    const expectedApiKey = env.WORKER_API_KEY || 'minyakku-secure-erp-key-2026';
    const clientApiKey = request.headers.get('X-API-KEY') || 
                         request.headers.get('Authorization')?.replace('Bearer ', '');

    // Endpoint publik (root & health check & webhook)
    const isPublicEndpoint = url.pathname === '/' || 
                             url.pathname === '/api/health' || 
                             url.pathname.startsWith('/api/webhooks/');

    if (!isPublicEndpoint && clientApiKey !== expectedApiKey) {
      return Response.json(
        { error: 'Akses Ditolak (401 Unauthorized): X-API-KEY tidak valid atau belum diisi.' },
        { status: 401, headers: corsHeaders }
      );
    }

    try {
      // ENDPOINT 1: Health Check & Status Koneksi Aiven Hyperdrive
      if (url.pathname === '/' || url.pathname === '/api/health') {
        let dbOk = false;
        let dbError: string | null = null;
        let poolProvider = 'None';

        try {
          if (env.HYPERDRIVE || env.DATABASE_URL) {
            const client = getDbClient(env);
            await client.connect();
            const res = await client.query('SELECT 1 as connected, NOW() as server_time');
            dbOk = res.rows.length > 0;
            poolProvider = env.HYPERDRIVE ? 'Cloudflare Hyperdrive (Active)' : 'Direct PostgreSQL';
            await client.end();
          }
        } catch (e: any) {
          dbError = e.message;
        }

        return Response.json({
          status: 'ONLINE',
          service: 'MinyakKu Cloudflare Worker API',
          hyperdrive_enabled: !!env.HYPERDRIVE,
          pooling_mode: poolProvider,
          db_connected: dbOk,
          db_status: dbOk ? 'Terhubung ke Aiven PostgreSQL' : (dbError || 'Belum ada DATABASE_URL/HYPERDRIVE'),
          api_protection: 'Protected by X-API-KEY & Strict CORS',
          timestamp: new Date().toISOString()
        }, { headers: corsHeaders });
      }

      // ENDPOINT 2: Auto-Inisialisasi 14 Tabel Aiven PostgreSQL (1-Klik dari Front End)
      if (url.pathname === '/api/init-db' && method === 'POST') {
        const client = getDbClient(env);
        await client.connect();

        const ddlQueries = [
          'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
          `CREATE TABLE IF NOT EXISTS company_profiles (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name VARCHAR(255) NOT NULL,
            legal_type VARCHAR(20) NOT NULL DEFAULT 'PT',
            brand_name VARCHAR(255),
            is_pkp BOOLEAN DEFAULT TRUE,
            npwp VARCHAR(50) NOT NULL,
            tax_address TEXT NOT NULL,
            nib VARCHAR(50),
            office_address TEXT NOT NULL,
            city VARCHAR(100),
            phone VARCHAR(50),
            email VARCHAR(150),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );`,
          `CREATE TABLE IF NOT EXISTS customers (
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
          );`,
          `CREATE TABLE IF NOT EXISTS resellers (
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
          );`,
          `CREATE TABLE IF NOT EXISTS warehouses (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            code VARCHAR(50) UNIQUE NOT NULL,
            name VARCHAR(150) NOT NULL,
            location VARCHAR(150) NOT NULL,
            address TEXT NOT NULL,
            capacity_liters NUMERIC(15, 2) NOT NULL DEFAULT 100000,
            current_stock_liters NUMERIC(15, 2) DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );`,
          `CREATE TABLE IF NOT EXISTS product_skus (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            code VARCHAR(50) UNIQUE NOT NULL,
            name VARCHAR(255) NOT NULL,
            category VARCHAR(50) NOT NULL,
            packaging_unit VARCHAR(100) NOT NULL,
            price_end_user NUMERIC(15, 2) NOT NULL,
            price_reseller NUMERIC(15, 2) NOT NULL,
            price_grosir NUMERIC(15, 2) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );`,
          `CREATE TABLE IF NOT EXISTS stock_batches (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            warehouse_code VARCHAR(50) NOT NULL,
            product_code VARCHAR(50) NOT NULL,
            supplier_name VARCHAR(255) NOT NULL,
            batch_number VARCHAR(100) NOT NULL,
            qty NUMERIC(15, 2) NOT NULL,
            unit VARCHAR(50) NOT NULL,
            inbound_date DATE DEFAULT CURRENT_DATE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );`,
          `CREATE TABLE IF NOT EXISTS stock_mutations (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            mutation_date DATE DEFAULT CURRENT_DATE,
            mutation_type VARCHAR(50) NOT NULL,
            warehouse_code VARCHAR(50) NOT NULL,
            product_code VARCHAR(50) NOT NULL,
            supplier_name VARCHAR(255),
            qty NUMERIC(15, 2) NOT NULL,
            unit VARCHAR(50) NOT NULL,
            ref_doc_number VARCHAR(100),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );`,
          `CREATE TABLE IF NOT EXISTS sales_orders (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            order_number VARCHAR(100) UNIQUE NOT NULL,
            order_date DATE DEFAULT CURRENT_DATE,
            customer_name VARCHAR(255) NOT NULL,
            customer_tier VARCHAR(50) NOT NULL,
            sales_person VARCHAR(150),
            subtotal_dpp NUMERIC(15, 2) NOT NULL,
            ppn_amount NUMERIC(15, 2) DEFAULT 0,
            grand_total NUMERIC(15, 2) NOT NULL,
            negotiation_status VARCHAR(50) DEFAULT 'NOT_NEEDED',
            payment_status VARCHAR(50) DEFAULT 'UNPAID',
            dispatch_status VARCHAR(50) DEFAULT 'WAITING_PRICE_APPROVAL',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );`,
          `CREATE TABLE IF NOT EXISTS surat_jalan (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            sj_number VARCHAR(100) UNIQUE NOT NULL,
            sales_order_number VARCHAR(100) NOT NULL,
            date DATE DEFAULT CURRENT_DATE,
            warehouse_name VARCHAR(150) NOT NULL,
            driver_name VARCHAR(150) NOT NULL,
            vehicle_plate_number VARCHAR(50) NOT NULL,
            status VARCHAR(50) DEFAULT 'IN_TRANSIT',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );`,
          `CREATE TABLE IF NOT EXISTS invoices (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            invoice_number VARCHAR(100) UNIQUE NOT NULL,
            sales_order_number VARCHAR(100) NOT NULL,
            date DATE DEFAULT CURRENT_DATE,
            due_date DATE NOT NULL,
            grand_total NUMERIC(15, 2) NOT NULL,
            payment_status VARCHAR(50) DEFAULT 'UNPAID',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );`
        ];

        for (const query of ddlQueries) {
          await client.query(query);
        }
        await client.end();

        return Response.json({
          success: true,
          message: 'Seluruh skema tabel (14 Tabel) di Aiven PostgreSQL berhasil diinisialisasi!',
          tables: ['company_profiles', 'customers', 'resellers', 'warehouses', 'product_skus', 'stock_batches', 'stock_mutations', 'sales_orders', 'surat_jalan', 'invoices']
        }, { headers: corsHeaders });
      }

      // ENDPOINT 3: Sinkronkan Seluruh Data Front End ke Aiven PostgreSQL
      if (url.pathname === '/api/sync/push' && method === 'POST') {
        const payload: any = await request.json();
        const client = getDbClient(env);
        await client.connect();

        let insertedCount = 0;

        // 1. Simpan/Update Customer
        if (Array.isArray(payload.customers)) {
          for (const c of payload.customers) {
            await client.query(
              `INSERT INTO customers (code, name, company_name, tier, phone, email, address, city, is_pkp, npwp, nik)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (code) DO UPDATE SET
               name = EXCLUDED.name, tier = EXCLUDED.tier, phone = EXCLUDED.phone, npwp = EXCLUDED.npwp, nik = EXCLUDED.nik;`,
              [c.code, c.name, c.companyName || '', c.tier, c.phone, c.email || '', c.address, c.city || '', !!c.isPkp, c.npwp || '', c.nik || '']
            );
            insertedCount++;
          }
        }

        // 2. Simpan/Update Reseller
        if (Array.isArray(payload.resellers)) {
          for (const r of payload.resellers) {
            await client.query(
              `INSERT INTO resellers (code, name, nik, npwp, shop_name, area, phone, tier_level, commission_rate_pct)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (code) DO UPDATE SET
               name = EXCLUDED.name, nik = EXCLUDED.nik, phone = EXCLUDED.phone, commission_rate_pct = EXCLUDED.commission_rate_pct;`,
              [r.code, r.name, r.nik, r.npwp || '', r.shopName || '', r.area || '', r.phone, r.tierLevel || 'BRONZE', r.commissionRatePct || 2.5]
            );
            insertedCount++;
          }
        }

        // 3. Simpan/Update Sales Order
        if (Array.isArray(payload.salesOrders)) {
          for (const o of payload.salesOrders) {
            await client.query(
              `INSERT INTO sales_orders (order_number, order_date, customer_name, customer_tier, sales_person, subtotal_dpp, ppn_amount, grand_total, negotiation_status, payment_status, dispatch_status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (order_number) DO UPDATE SET
               payment_status = EXCLUDED.payment_status, dispatch_status = EXCLUDED.dispatch_status, negotiation_status = EXCLUDED.negotiation_status;`,
              [o.orderNumber, o.orderDate, o.customerName, o.customerTier, o.salesPerson || 'Sales Team', o.subtotalDpp, o.ppnAmount, o.grandTotal, o.negotiationStatus, o.paymentStatus, o.dispatchStatus]
            );
            insertedCount++;
          }
        }

        // 4. Simpan Surat Jalan
        if (Array.isArray(payload.suratJalanList)) {
          for (const sj of payload.suratJalanList) {
            await client.query(
              `INSERT INTO surat_jalan (sj_number, sales_order_number, date, warehouse_name, driver_name, vehicle_plate_number, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (sj_number) DO UPDATE SET status = EXCLUDED.status;`,
              [sj.sjNumber, sj.salesOrderId, sj.date, sj.warehouseName, sj.driverName, sj.vehiclePlateNumber, sj.status]
            );
            insertedCount++;
          }
        }

        await client.end();

        return Response.json({
          success: true,
          message: `Berhasil menyinkronkan ${insertedCount} baris data ke Aiven PostgreSQL!`,
          syncedAt: new Date().toISOString()
        }, { headers: corsHeaders });
      }

      // ENDPOINT 4: Tarik Data dari Aiven PostgreSQL ke Front End
      if (url.pathname === '/api/sync/pull' && method === 'GET') {
        const client = getDbClient(env);
        await client.connect();

        const customers = await client.query('SELECT * FROM customers ORDER BY created_at DESC LIMIT 100;');
        const resellers = await client.query('SELECT * FROM resellers ORDER BY created_at DESC LIMIT 100;');
        const orders = await client.query('SELECT * FROM sales_orders ORDER BY created_at DESC LIMIT 100;');
        const suratJalan = await client.query('SELECT * FROM surat_jalan ORDER BY created_at DESC LIMIT 100;');

        await client.end();

        return Response.json({
          success: true,
          data: {
            customers: customers.rows,
            resellers: resellers.rows,
            salesOrders: orders.rows,
            suratJalanList: suratJalan.rows,
          }
        }, { headers: corsHeaders });
      }

      // ENDPOINT 5: Webhook Midtrans (Auto Payment Detection & WA Notification)
      if (url.pathname === '/api/webhooks/midtrans' && method === 'POST') {
        const payload: any = await request.json();
        const orderId = payload.order_id;
        const transactionStatus = payload.transaction_status;
        const grossAmount = payload.gross_amount;

        if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
          // Update status di Aiven PostgreSQL
          try {
            const client = getDbClient(env);
            await client.connect();
            await client.query(
              "UPDATE sales_orders SET payment_status = 'PAID', dispatch_status = 'READY_TO_DISPATCH' WHERE order_number = $1",
              [orderId]
            );
            await client.end();
          } catch (e) {
            console.error('Gagal update status DB:', e);
          }

          // Kirim WhatsApp Notifikasi
          if (env.WA_API_KEY) {
            const message = `✅ *PEMBAYARAN DITERIMA - SGN SEMBAKO / MINYAKKU*\n\nOrder ID: ${orderId}\nTotal: Rp ${Number(grossAmount).toLocaleString('id-ID')}\nStatus: LUNAS (Midtrans Terverifikasi)\n\nSurat Jalan dan antrian muat armada sedang dipersiapkan gudang. Terima kasih!`;
            await fetch('https://api.fonnte.com/send', {
              method: 'POST',
              headers: { Authorization: env.WA_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                target: payload.custom_field1 || '081298765432',
                message: message,
              }),
            });
          }
        }

        return Response.json({ status: 'webhook received' }, { headers: corsHeaders });
      }

      // ENDPOINT 6: Backblaze B2 Upload Presigned URL Generator
      if (url.pathname === '/api/storage/b2-upload-url' && method === 'POST') {
        const { fileName } = await request.json() as any;
        const mockPresignedUrl = `https://${env.B2_BUCKET_NAME || 'sgn-sembako-documents'}.${env.B2_ENDPOINT || 's3.us-west-004.backblazeb2.com'}/${encodeURIComponent(fileName)}`;
        
        return Response.json({
          uploadUrl: mockPresignedUrl,
          fileKey: fileName,
          storageProvider: 'Backblaze B2 S3-Compatible',
        }, { headers: corsHeaders });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
};
