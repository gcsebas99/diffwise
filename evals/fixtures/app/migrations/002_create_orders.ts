import type { Migration } from "./types.ts";

export const migration: Migration = {
  id: "002_create_orders",
  up: `
    CREATE TABLE orders (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      total_cents INTEGER NOT NULL CHECK (total_cents > 0),
      status      TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX orders_user_id_idx ON orders(user_id);
  `,
  down: `
    DROP INDEX orders_user_id_idx;
    DROP TABLE orders;
  `,
};
