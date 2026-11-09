export interface User {
  id: string;
  email: string;
  name: string;
}

export type OrderStatus = "pending" | "paid" | "shipped";

export interface Order {
  id: string;
  userId: string;
  totalCents: number;
  status: OrderStatus;
}

// In-memory stand-in for a real database; the migrations describe the real schema.
export class Db {
  users = new Map<string, User>();
  orders = new Map<string, Order>();
  private seq = 0;

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }
}
