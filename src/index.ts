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

      // 2. Init DB
      if ((pathname === '/api/init-db' || pathname === '/init-db') && method === 'POST') {
        if (env.DB) {
          // Cloudflare D1 SQLite
          await env.DB.batch([
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
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS sales_orders (
              id TEXT PRIMARY KEY,
              order_number TEXT UNIQUE NOT NULL,
              order_date TEXT,
              customer_name TEXT,
              customer_tier TEXT,
              sales_person TEXT,
              subtotal_dpp REAL DEFAULT 0,
              ppn_amount REAL DEFAULT 0,
              grand_total REAL DEFAULT 0,
              negotiation_status TEXT DEFAULT 'NOT_NEEDED',
              payment_status TEXT DEFAULT 'UNPAID',
              dispatch_status TEXT DEFAULT 'WAITING_PRICE_APPROVAL',
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS surat_jalan (
              id TEXT PRIMARY KEY,
              sj_number TEXT UNIQUE NOT NULL,
              sales_order_number TEXT NOT NULL,
              date TEXT,
              warehouse_name TEXT NOT NULL,
              driver_name TEXT NOT NULL,
              vehicle_plate_number TEXT NOT NULL,
              status TEXT DEFAULT 'IN_TRANSIT',
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS warehouses (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              address TEXT NOT NULL,
              city TEXT,
              pic_name TEXT,
              is_primary INTEGER DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
              id TEXT PRIMARY KEY,
              sku TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              packaging TEXT NOT NULL,
              volume_liters REAL NOT NULL,
              standard_cogs REAL NOT NULL,
              min_selling_price REAL NOT NULL,
              base_price_dpp REAL NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`)
          ]);
          return Response.json({ success: true, message: 'Tabel Cloudflare D1 SQLite berhasil disiapkan (5GB Storage Siap)!' }, { headers: corsHeaders });
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

          if (Array.isArray(payload.customers)) {
            for (const c of payload.customers) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO customers (id, code, name, company_name, tier, phone, email, address, city, is_pkp, npwp, nik)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                   ON CONFLICT(code) DO UPDATE SET name=excluded.name, tier=excluded.tier, phone=excluded.phone, address=excluded.address`
                ).bind(c.id || c.code, c.code, c.name, c.companyName || '', c.tier || 'END_USER', c.phone, c.email || '', c.address, c.city || '', c.isPkp ? 1 : 0, c.npwp || '', c.nik || '')
              );
            }
          }

          if (Array.isArray(payload.resellers)) {
            for (const r of payload.resellers) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO resellers (id, code, name, nik, npwp, shop_name, area, phone, tier_level, commission_rate_pct)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                   ON CONFLICT(code) DO UPDATE SET name=excluded.name, phone=excluded.phone, nik=excluded.nik`
                ).bind(r.id || r.code, r.code, r.name, r.nik, r.npwp || '', r.shopName || '', r.area || '', r.phone, r.tierLevel || 'BRONZE', Number(r.commissionRatePct) || 2.5)
              );
            }
          }

          if (Array.isArray(payload.salesOrders)) {
            for (const o of payload.salesOrders) {
              const subtotal = Number(o.subtotalDpp ?? o.subtotal_dpp ?? o.subtotal ?? 0);
              const ppn = Number(o.ppnAmount ?? o.ppn_amount ?? o.ppn ?? 0);
              const grand = Number(o.grandTotal ?? o.grand_total ?? (subtotal + ppn));
              const orderDt = o.date || o.orderDate || new Date().toISOString().split('T')[0];

              stmts.push(
                env.DB.prepare(
                  `INSERT INTO sales_orders (id, order_number, order_date, customer_name, customer_tier, sales_person, subtotal_dpp, ppn_amount, grand_total, negotiation_status, payment_status, dispatch_status)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                   ON CONFLICT(order_number) DO UPDATE SET payment_status=excluded.payment_status, dispatch_status=excluded.dispatch_status`
                ).bind(o.id || o.orderNumber, o.orderNumber, orderDt, o.customerName || 'Customer', o.customerTier || 'END_USER', o.salesPerson || 'Sales', subtotal, ppn, grand, o.negotiationStatus || 'NOT_NEEDED', o.paymentStatus || 'UNPAID', o.dispatchStatus || 'WAITING_PRICE_APPROVAL')
              );
              insertedOrders++;
            }
          }

          if (Array.isArray(payload.suratJalanList)) {
            for (const sj of payload.suratJalanList) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO surat_jalan (id, sj_number, sales_order_number, date, warehouse_name, driver_name, vehicle_plate_number, status)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                   ON CONFLICT(sj_number) DO UPDATE SET status=excluded.status`
                ).bind(sj.id || sj.sjNumber, sj.sjNumber, sj.salesOrderId || sj.salesOrderNumber || '', sj.date, sj.warehouseName, sj.driverName, sj.vehiclePlateNumber, sj.status || 'IN_TRANSIT')
              );
            }
          }

          if (stmts.length > 0) {
            await env.DB.batch(stmts);
          }

          return Response.json({
            success: true,
            database: 'Cloudflare D1 SQLite (5GB Gratis)',
            message: `Berhasil menyimpan data ke Cloudflare D1 Database! (${insertedOrders} order tersinkron)`,
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
          const customers = (await env.DB.prepare('SELECT * FROM customers ORDER BY created_at DESC').all()).results || [];
          const resellers = (await env.DB.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all()).results || [];
          const salesOrders = (await env.DB.prepare('SELECT * FROM sales_orders ORDER BY created_at DESC').all()).results || [];
          const suratJalanList = (await env.DB.prepare('SELECT * FROM surat_jalan ORDER BY created_at DESC').all()).results || [];

          return Response.json({
            success: true,
            database: 'Cloudflare D1 SQLite',
            data: {
              customers,
              resellers,
              salesOrders,
              suratJalanList,
            }
          }, { headers: corsHeaders });
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

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  }
};
