import type { Migration } from "./types.ts";

export const migration: Migration = {
  id: "001_create_users",
  up: `
    CREATE TABLE users (
      id    TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name  TEXT NOT NULL
    );
  `,
  down: "DROP TABLE users;",
};
