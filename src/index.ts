import { Client } from "pg";

export default {
  async fetch(request, env, ctx) {
    // Hyperdrive provides a unique generated connection string to connect to
    // your database via Hyperdrive that can be used with your existing tools
    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
    await client.connect();

    try {
      // Sample SQL query
      const result = await client.query("SELECT * FROM pg_tables");

      return Response.json({result: result.rows});
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : e }, { status: 500 });
    }
  },
}import { Client } from 'pg';

export interface Env {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
}

function getDbClient(env: Env): Client {
  const connString = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!connString) throw new Error('DATABASE_URL or HYPERDRIVE missing');
  return new Client({ connectionString: connString, ssl: { rejectUnauthorized: false } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-KEY',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
      if (url.pathname === '/' || url.pathname === '/api/health') {
        let dbOk = false;
        if (env.HYPERDRIVE || env.DATABASE_URL) {
          try {
            const c = getDbClient(env);
            await c.connect();
            await c.query('SELECT 1');
            dbOk = true;
            await c.end();
          } catch(e) {}
        }
        return Response.json({ status: 'ONLINE', db_connected: dbOk }, { headers: corsHeaders });
      }

      if (url.pathname === '/api/sync/push' && request.method === 'POST') {
        const payload: any = await request.json();
        const client = getDbClient(env);
        await client.connect();
        let count = 0;
        if (Array.isArray(payload.customers)) {
          for (const c of payload.customers) {
            await client.query(
              'INSERT INTO customers (code, name, tier, phone, address) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name',
              [c.code, c.name, c.tier, c.phone, c.address]
            );
          }
        }
        if (Array.isArray(payload.salesOrders)) {
          for (const o of payload.salesOrders) {
            await client.query(
              'INSERT INTO sales_orders (order_number, customer_name, customer_tier, grand_total, payment_status, dispatch_status) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (order_number) DO UPDATE SET payment_status=EXCLUDED.payment_status',
              [o.orderNumber, o.customerName, o.customerTier, o.grandTotal, o.paymentStatus, o.dispatchStatus]
            );
            count++;
          }
        }
        await client.end();
        return Response.json({ success: true, message: 'Data saved to Aiven!', count }, { headers: corsHeaders });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch(err: any) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  }
};
