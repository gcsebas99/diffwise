import type { IncomingMessage, ServerResponse } from "node:http";

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
  user?: { id: string };
}

export interface Response {
  status: number;
  body: unknown;
}

export type Handler = (req: Request) => Response | Promise<Response>;
export type Middleware = (req: Request) => Response | undefined;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  private middleware: Middleware[] = [];

  use(mw: Middleware): void {
    this.middleware.push(mw);
  }

  get(path: string, handler: Handler): void {
    this.add("GET", path, handler);
  }

  post(path: string, handler: Handler): void {
    this.add("POST", path, handler);
  }

  private add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, segments: path.split("/").filter(Boolean), handler });
  }

  async handle(req: Omit<Request, "params">): Promise<Response> {
    const parts = req.path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== req.method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const matches = route.segments.every((seg, i) => {
        const part = parts[i] ?? "";
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(part);
          return true;
        }
        return seg === part;
      });
      if (!matches) continue;

      const full: Request = { ...req, params };
      for (const mw of this.middleware) {
        const early = mw(full);
        if (early) return early;
      }
      return route.handler(full);
    }
    return { status: 404, body: { error: "not found" } };
  }
}

export async function toNodeHandler(router: Router, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");

  const result = await router.handle({
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    body: raw ? JSON.parse(raw) : undefined,
  });

  res.writeHead(result.status, { "content-type": "application/json" });
  res.end(JSON.stringify(result.body));
}
