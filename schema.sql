DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS menu;

CREATE TABLE menu (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  category     TEXT    NOT NULL DEFAULT 'Lainnya',
  price        INTEGER NOT NULL CHECK (price >= 0),
  is_available INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_number  INTEGER NOT NULL,
  queue_date    TEXT    NOT NULL,                 -- YYYY-MM-DD (WIB), nomor reset tiap hari
  customer_name TEXT,
  note          TEXT,
  status        TEXT    NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting','preparing','ready','done','cancelled')),
  total         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_orders_day_number ON orders (queue_date, queue_number);
CREATE INDEX idx_orders_day_status ON orders (queue_date, status);

CREATE TABLE order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_id  INTEGER NOT NULL REFERENCES menu(id),
  name     TEXT    NOT NULL,
  qty      INTEGER NOT NULL CHECK (qty > 0),
  price    INTEGER NOT NULL
);

CREATE INDEX idx_items_order ON order_items (order_id);
