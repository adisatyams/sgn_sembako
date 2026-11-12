// Skema D1 untuk modul Suplier, Purchase Order, Barang Masuk, Faktur Pajak Masukan,
// Pembayaran Suplier, dan Pembukuan (jurnal). Semua pakai CREATE ... IF NOT EXISTS,
// jadi aman dijalankan berulang lewat POST /api/erp/init.

export const ERP_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS doc_counters (
    key TEXT PRIMARY KEY,
    last INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    legal_type TEXT DEFAULT 'PT',
    npwp TEXT NOT NULL,
    nitku TEXT DEFAULT '',
    is_pkp INTEGER NOT NULL DEFAULT 1,
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    pic_name TEXT DEFAULT '',
    bank_name TEXT DEFAULT '',
    bank_account_no TEXT DEFAULT '',
    bank_account_name TEXT DEFAULT '',
    payment_terms_days INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_suppliers_npwp ON suppliers(npwp)`,

  `CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    po_number TEXT UNIQUE NOT NULL,
    supplier_id TEXT NOT NULL,
    order_date TEXT NOT NULL,
    expected_date TEXT DEFAULT '',
    warehouse_id TEXT DEFAULT '',
    warehouse_name TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    subtotal REAL NOT NULL DEFAULT 0,
    ppn_amount REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id)`,

  `CREATE TABLE IF NOT EXISTS purchase_order_items (
    id TEXT PRIMARY KEY,
    po_id TEXT NOT NULL,
    line_no INTEGER NOT NULL,
    product_sku_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit TEXT NOT NULL,
    qty REAL NOT NULL,
    unit_price REAL NOT NULL,
    tax_code TEXT NOT NULL DEFAULT '04',
    amount REAL NOT NULL,
    ppn REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    qty_received REAL NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poi_po ON purchase_order_items(po_id)`,

  `CREATE TABLE IF NOT EXISTS goods_receipts (
    id TEXT PRIMARY KEY,
    gr_number TEXT UNIQUE NOT NULL,
    po_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    warehouse_id TEXT DEFAULT '',
    warehouse_name TEXT DEFAULT '',
    receipt_date TEXT NOT NULL,
    supplier_delivery_note TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gr_po ON goods_receipts(po_id)`,

  `CREATE TABLE IF NOT EXISTS goods_receipt_items (
    id TEXT PRIMARY KEY,
    gr_id TEXT NOT NULL,
    po_item_id TEXT NOT NULL,
    product_sku_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit TEXT NOT NULL,
    qty REAL NOT NULL,
    batch_number TEXT DEFAULT '',
    expired_date TEXT DEFAULT '',
    stock_batch_id TEXT DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gri_gr ON goods_receipt_items(gr_id)`,

  // Tagihan + Faktur Pajak Masukan dari suplier. File PDF faktur disimpan di Backblaze B2.
  `CREATE TABLE IF NOT EXISTS supplier_invoices (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL,
    po_id TEXT DEFAULT '',
    invoice_number TEXT DEFAULT '',
    invoice_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    fp_number TEXT NOT NULL,
    fp_date TEXT NOT NULL,
    masa_pajak_month INTEGER NOT NULL,
    masa_pajak_year INTEGER NOT NULL,
    purchase_category TEXT NOT NULL DEFAULT 'UMUM',
    harga REAL NOT NULL,
    dpp REAL NOT NULL,
    ppn REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL,
    paid_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'UPLOADED',
    payment_status TEXT NOT NULL DEFAULT 'UNPAID',
    file_key TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    file_sha256 TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_si_supplier_fp ON supplier_invoices(supplier_id, fp_number)`,
  `CREATE INDEX IF NOT EXISTS idx_si_masa ON supplier_invoices(masa_pajak_year, masa_pajak_month)`,

  `CREATE TABLE IF NOT EXISTS supplier_payments (
    id TEXT PRIMARY KEY,
    pay_number TEXT UNIQUE NOT NULL,
    supplier_invoice_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    pay_date TEXT NOT NULL,
    amount REAL NOT NULL,
    pph_amount REAL NOT NULL DEFAULT 0,
    cash_paid REAL NOT NULL,
    method TEXT NOT NULL DEFAULT 'BANK',
    reference TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sp_invoice ON supplier_payments(supplier_invoice_id)`,

  // Pembukuan: daftar akun + jurnal berpasangan (debit = kredit).
  `CREATE TABLE IF NOT EXISTS accounts (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    normal_balance TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  )`,

  `CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    entry_date TEXT NOT NULL,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    memo TEXT DEFAULT '',
    source TEXT NOT NULL DEFAULT 'AUTO',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ref_type, ref_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries(entry_date)`,

  `CREATE TABLE IF NOT EXISTS journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    account_code TEXT NOT NULL,
    debit REAL NOT NULL DEFAULT 0,
    credit REAL NOT NULL DEFAULT 0,
    memo TEXT DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_code)`,

  // Tabel milik modul lama (di-sync dari front end). Dibuat di sini juga supaya laporan
  // PPN keluaran & piutang tidak error pada database yang belum pernah di-sync.
  `CREATE TABLE IF NOT EXISTS invoices (
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
  )`,
  `CREATE TABLE IF NOT EXISTS sales_orders (
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
  )`,
];

// Daftar akun mengikuti Master_Pembukuan (Sheet 0). Nama akun yang tidak terbaca jelas di
// spreadsheet diberi tanda "(sesuaikan)" dan bisa diganti lewat PUT /api/erp/accounts/:code.
// [kode, nama, tipe, saldo normal]
export const SEED_ACCOUNTS: Array<[string, string, string, string]> = [
  ['1101', 'Kas Tunai', 'ASSET', 'D'],
  ['1102', 'Bank PT', 'ASSET', 'D'],
  ['1103', 'Piutang Usaha (Tempo)', 'ASSET', 'D'],
  ['1104', 'Persediaan Barang Dagang', 'ASSET', 'D'],
  ['1105', 'PPN Masukan', 'ASSET', 'D'],
  ['1106', 'Uang Muka Pajak (PPh 22 / PPh 25)', 'ASSET', 'D'],
  ['1201', 'Peralatan & Aset Tetap', 'ASSET', 'D'],
  ['1202', 'Akumulasi Penyusutan', 'ASSET', 'C'],
  ['2101', 'Utang Usaha (Suplier)', 'LIABILITY', 'C'],
  ['2102', 'Utang PPN', 'LIABILITY', 'C'],
  ['2103', 'Utang PPh Dipotong (PPh 21 / 23 / 4(2))', 'LIABILITY', 'C'],
  ['2104', 'Utang PPh Badan (Pasal 29)', 'LIABILITY', 'C'],
  ['2201', 'Utang Pemegang Saham', 'LIABILITY', 'C'],
  ['3101', 'Modal Saham Disetor', 'EQUITY', 'C'],
  ['3102', 'Laba Ditahan Awal', 'EQUITY', 'C'],
  ['4101', 'Penjualan BKP Strategis (Beras, Telur, Garam, Gula)', 'REVENUE', 'C'],
  ['4102', 'Penjualan BKP Umum Non-Mewah (Minyak Goreng, Terigu, Mie)', 'REVENUE', 'C'],
  ['4103', 'Retur Penjualan BKP Strategis', 'REVENUE', 'D'],
  ['4104', 'Retur Penjualan BKP Umum', 'REVENUE', 'D'],
  ['5101', 'Persediaan Awal', 'COGS', 'D'],
  ['5102', 'Pembelian BKP Strategis', 'COGS', 'D'],
  ['5103', 'Pembelian BKP Umum', 'COGS', 'D'],
  ['5104', 'Biaya Angkut Pembelian', 'COGS', 'D'],
  ['5105', 'Persediaan Akhir', 'COGS', 'C'],
  ['6101', 'Beban Penjualan & Distribusi (sesuaikan)', 'EXPENSE', 'D'],
  ['6102', 'BBM & Operasional Armada (sesuaikan)', 'EXPENSE', 'D'],
  ['6103', 'Ongkos Kirim / Ekspedisi (sesuaikan)', 'EXPENSE', 'D'],
  ['6104', 'Beban Penjualan Lainnya (sesuaikan)', 'EXPENSE', 'D'],
  ['6105', 'Sewa Kendaraan (Gran Max)', 'EXPENSE', 'D'],
  ['6201', 'Gaji Admin & Gudang (sesuaikan)', 'EXPENSE', 'D'],
  ['6202', 'Sewa Gudang', 'EXPENSE', 'D'],
  ['6203', 'Listrik, Air & Internet (sesuaikan)', 'EXPENSE', 'D'],
  ['6204', 'Beban Umum & Administrasi Lainnya (sesuaikan)', 'EXPENSE', 'D'],
  ['6205', 'Beban Umum & Administrasi Lainnya 2 (sesuaikan)', 'EXPENSE', 'D'],
  ['6206', 'PPN Masukan Tidak Dapat Dikreditkan', 'EXPENSE', 'D'],
  ['6207', 'Gaji Direktur', 'EXPENSE', 'D'],
  ['7101', 'Penghasilan Bunga', 'OTHER_INCOME', 'C'],
  ['7201', 'Beban Bunga Pemegang Saham', 'OTHER_EXPENSE', 'D'],
  ['8301', 'Beban PPh Badan', 'TAX_EXPENSE', 'D'],
];

export const PNL_TYPES = ['REVENUE', 'COGS', 'EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE', 'TAX_EXPENSE'];
