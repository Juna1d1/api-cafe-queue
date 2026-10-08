import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

const ACTIVE_STATUSES = ['waiting', 'preparing', 'ready'];
const ALL_STATUSES = ['waiting', 'preparing', 'ready', 'done', 'cancelled'];

// ---------- helpers ----------

// Tanggal hari ini di WIB (UTC+7). Nomor antrian reset tiap hari mengikuti tanggal ini.
function todayWIB() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function placeholders(n) {
  return Array(n).fill('?').join(',');
}

// ---------- middleware ----------

app.use('/api/*', async (c, next) => {
  const list = (c.env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return cors({
    origin: list.includes('*') ? '*' : list,
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-staff-pin'],
    maxAge: 86400,
  })(c, next);
});

// Kasir & dapur memakai PIN yang disimpan sebagai secret STAFF_PIN.
const staffOnly = async (c, next) => {
  const pin = c.req.header('x-staff-pin') || '';
  const expected = c.env.STAFF_PIN || '';
  if (!expected) return c.json({ error: 'STAFF_PIN belum diatur di server' }, 500);
  if (!safeEqual(pin, expected)) return c.json({ error: 'PIN salah' }, 401);
  await next();
};

// ---------- routes ----------

app.get('/', (c) => c.json({ name: 'api-cafe-queue', ok: true }));

// Cek PIN dari halaman kasir/dapur
app.post('/api/login', staffOnly, (c) => c.json({ ok: true }));

// Menu (publik)
app.get('/api/menu', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, category, price, is_available FROM menu ORDER BY category, name'
  ).all();
  return c.json({ menu: results });
});

// Tambah menu (staff)
app.post('/api/menu', staffOnly, async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = String(body?.name || '').trim();
  const category = String(body?.category || 'Lainnya').trim() || 'Lainnya';
  const price = Number(body?.price);
  if (!name || name.length > 80) return c.json({ error: 'Nama menu wajib diisi (maks. 80 karakter)' }, 400);
  if (!Number.isInteger(price) || price < 0) return c.json({ error: 'Harga harus bilangan bulat ≥ 0' }, 400);

  const res = await c.env.DB.prepare('INSERT INTO menu (name, category, price) VALUES (?, ?, ?)')
    .bind(name, category, price)
    .run();
  return c.json({ id: res.meta.last_row_id }, 201);
});

// Ubah menu / tandai habis (staff)
app.patch('/api/menu/:id', staffOnly, async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const sets = [];
  const vals = [];

  if (body.is_available !== undefined) {
    sets.push('is_available = ?');
    vals.push(body.is_available ? 1 : 0);
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 0) return c.json({ error: 'Harga tidak valid' }, 400);
    sets.push('price = ?');
    vals.push(price);
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return c.json({ error: 'Nama tidak boleh kosong' }, 400);
    sets.push('name = ?');
    vals.push(name);
  }
  if (!sets.length) return c.json({ error: 'Tidak ada yang diubah' }, 400);

  const res = await c.env.DB.prepare(`UPDATE menu SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...vals, id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'Menu tidak ditemukan' }, 404);
  return c.json({ ok: true });
});

// Antrian aktif hari ini (publik, untuk layar TV). Tanpa detail item/harga.
// Dibatasi per status supaya tetap ringan saat antrian sangat panjang;
// jumlah sebenarnya dikirim di `counts`.
const QUEUE_CAP = 60;
app.get('/api/queue', async (c) => {
  const date = todayWIB();
  const [list, cnt] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, queue_number, customer_name, status, updated_at FROM (
         SELECT id, queue_number, customer_name, status, updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY status
                  ORDER BY CASE WHEN status = 'waiting' THEN queue_number ELSE -queue_number END
                ) AS rn
           FROM orders
          WHERE queue_date = ?1 AND status IN ('waiting','preparing','ready')
       ) WHERE rn <= ?2
       ORDER BY queue_number`
    ).bind(date, QUEUE_CAP),
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM orders
        WHERE queue_date = ? AND status IN ('waiting','preparing','ready') GROUP BY status`
    ).bind(date),
  ]);
  const counts = { waiting: 0, preparing: 0, ready: 0 };
  for (const r of cnt.results) counts[r.status] = r.n;
  c.header('Cache-Control', 'no-store');
  return c.json({ date, orders: list.results, counts });
});

// Buat pesanan (staff)
app.post('/api/orders', staffOnly, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.items) || !body.items.length) {
    return c.json({ error: 'Pesanan kosong' }, 400);
  }

  // Gabungkan item duplikat & validasi qty
  const wanted = new Map();
  for (const it of body.items.slice(0, 40)) {
    const menuId = Number(it?.menu_id);
    const qty = Number(it?.qty);
    if (!Number.isInteger(menuId) || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      return c.json({ error: 'Item pesanan tidak valid' }, 400);
    }
    wanted.set(menuId, (wanted.get(menuId) || 0) + qty);
  }

  const ids = [...wanted.keys()];
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, name, price, is_available FROM menu WHERE id IN (${placeholders(ids.length)})`
  )
    .bind(...ids)
    .all();

  if (rows.length !== ids.length) return c.json({ error: 'Ada menu yang tidak ditemukan' }, 400);
  const habis = rows.filter((r) => !r.is_available).map((r) => r.name);
  if (habis.length) return c.json({ error: `Menu habis: ${habis.join(', ')}` }, 409);

  // Harga selalu dari database, bukan dari client
  const lines = rows.map((r) => ({ ...r, qty: wanted.get(r.id) }));
  const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const customer = String(body.customer_name || '').trim().slice(0, 40) || null;
  const note = String(body.note || '').trim().slice(0, 200) || null;
  const date = todayWIB();

  // Nomor berikutnya dihitung di SQL; unique index mencegah nomor ganda
  // kalau dua kasir menekan tombol di waktu yang sama (kita ulangi saja).
  let orderId = null;
  for (let attempt = 0; attempt < 5 && !orderId; attempt++) {
    try {
      const res = await c.env.DB.prepare(
        `INSERT INTO orders (queue_number, queue_date, customer_name, note, total)
         SELECT COALESCE(MAX(queue_number), 0) + 1, ?1, ?2, ?3, ?4
           FROM orders WHERE queue_date = ?1`
      )
        .bind(date, customer, note, total)
        .run();
      orderId = res.meta.last_row_id;
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  if (!orderId) return c.json({ error: 'Gagal membuat nomor antrian, coba lagi' }, 503);

  try {
    await c.env.DB.batch(
      lines.map((l) =>
        c.env.DB.prepare(
          'INSERT INTO order_items (order_id, menu_id, name, qty, price) VALUES (?, ?, ?, ?, ?)'
        ).bind(orderId, l.id, l.name, l.qty, l.price)
      )
    );
  } catch (e) {
    await c.env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run();
    throw e;
  }

  const order = await c.env.DB.prepare(
    'SELECT id, queue_number, customer_name, status, total FROM orders WHERE id = ?'
  )
    .bind(orderId)
    .first();
  return c.json({ order }, 201);
});

// Daftar pesanan hari ini beserta item (staff, untuk dapur).
// ?limit=N (default 300, maks 500) mengambil N pesanan terlama; ?all=1 ikut menyertakan done/cancelled.
app.get('/api/orders', staffOnly, async (c) => {
  const all = c.req.query('all') === '1';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '300', 10) || 300, 1), 500);
  const statuses = all ? ALL_STATUSES : ACTIVE_STATUSES;
  const date = todayWIB();
  const marks = placeholders(statuses.length);

  const [ord, itm] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, queue_number, customer_name, note, status, total, created_at, updated_at
         FROM orders WHERE queue_date = ? AND status IN (${marks})
        ORDER BY queue_number LIMIT ?`
    ).bind(date, ...statuses, limit),
    c.env.DB.prepare(
      `SELECT order_id, name, qty FROM order_items
        WHERE order_id IN (
          SELECT id FROM orders WHERE queue_date = ? AND status IN (${marks})
           ORDER BY queue_number LIMIT ?)
        ORDER BY id`
    ).bind(date, ...statuses, limit),
  ]);

  const byOrder = new Map();
  for (const it of itm.results) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
    byOrder.get(it.order_id).push({ name: it.name, qty: it.qty });
  }
  c.header('Cache-Control', 'no-store');
  return c.json({
    orders: ord.results.map((o) => ({ ...o, items: byOrder.get(o.id) || [] })),
    limit,
  });
});

// Ringkasan hari ini per status (staff): jumlah pesanan & omzet
app.get('/api/stats', staffOnly, async (c) => {
  const date = todayWIB();
  const { results } = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue, MAX(queue_number) AS last_number
       FROM orders WHERE queue_date = ? GROUP BY status`
  )
    .bind(date)
    .all();
  const by_status = Object.fromEntries(ALL_STATUSES.map((s) => [s, { orders: 0, revenue: 0 }]));
  let totalOrders = 0, lastNumber = 0;
  for (const r of results) {
    by_status[r.status] = { orders: r.orders, revenue: r.revenue };
    totalOrders += r.orders;
    lastNumber = Math.max(lastNumber, r.last_number || 0);
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ date, total_orders: totalOrders, last_queue_number: lastNumber, by_status });
});

// Ubah status pesanan (staff)
app.patch('/api/orders/:id/status', staffOnly, async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  const status = body?.status;
  if (!ALL_STATUSES.includes(status)) {
    return c.json({ error: `Status harus salah satu dari: ${ALL_STATUSES.join(', ')}` }, 400);
  }
  const res = await c.env.DB.prepare(
    'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  )
    .bind(status, id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'Pesanan tidak ditemukan' }, 404);
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: 'Endpoint tidak ditemukan' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Terjadi kesalahan di server' }, 500);
});

export default app;
