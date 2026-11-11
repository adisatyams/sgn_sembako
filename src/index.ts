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
            )`)
          ]);
          return Response.json({ success: true, message: '9 Tabel Cloudflare D1 SQLite berhasil disiapkan (5GB Storage Siap)!' }, { headers: corsHeaders });
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
              const orderDt = o.date || o.orderDate || new Date().toISOString().split('T')[0];

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
                  JSON.stringify(o)
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

          if (stmts.length > 0) {
            await env.DB.batch(stmts);
          }

          return Response.json({
            success: true,
            database: 'Cloudflare D1 SQLite (5GB Gratis)',
            message: `Seluruh 9 tabel berhasil disinkronkan ke Cloudflare D1! (${savedStats.salesOrders} pesanan, ${savedStats.invoices} faktur, ${savedStats.products} produk, ${savedStats.customers} pelanggan)`,
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
          const companyRes = (await env.DB.prepare('SELECT * FROM company_profiles LIMIT 1').all()).results || [];
          const customers = (await env.DB.prepare('SELECT * FROM customers ORDER BY created_at ASC').all()).results || [];
          const resellers = (await env.DB.prepare('SELECT * FROM resellers ORDER BY created_at ASC').all()).results || [];
          const warehouses = (await env.DB.prepare('SELECT * FROM warehouses ORDER BY created_at ASC').all()).results || [];
          const products = (await env.DB.prepare('SELECT * FROM products ORDER BY created_at ASC').all()).results || [];
          const stockBatches = (await env.DB.prepare('SELECT * FROM stock_batches ORDER BY created_at ASC').all()).results || [];
          const salesOrders = (await env.DB.prepare('SELECT * FROM sales_orders ORDER BY created_at DESC').all()).results || [];
          const suratJalanList = (await env.DB.prepare('SELECT * FROM surat_jalan ORDER BY created_at DESC').all()).results || [];
          const invoices = (await env.DB.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all()).results || [];

          return Response.json({
            success: true,
            database: 'Cloudflare D1 SQLite (5GB Gratis)',
            data: {
              company: companyRes[0]?.data_json ? JSON.parse(companyRes[0].data_json) : companyRes[0] || null,
              customers: customers.map((c: any) => c.data_json ? JSON.parse(c.data_json) : c),
              resellers: resellers.map((r: any) => r.data_json ? JSON.parse(r.data_json) : r),
              warehouses: warehouses.map((w: any) => w.data_json ? JSON.parse(w.data_json) : w),
              products: products.map((p: any) => p.data_json ? JSON.parse(p.data_json) : p),
              stockBatches: stockBatches.map((b: any) => b.data_json ? JSON.parse(b.data_json) : b),
              salesOrders: salesOrders.map((o: any) => o.data_json ? JSON.parse(o.data_json) : o),
              suratJalanList: suratJalanList.map((sj: any) => sj.data_json ? JSON.parse(sj.data_json) : sj),
              invoices: invoices.map((inv: any) => inv.data_json ? JSON.parse(inv.data_json) : inv),
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
