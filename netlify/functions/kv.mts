import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "wordrace", consistency: "strong" });
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const key = url.searchParams.get("key");
      const prefix = url.searchParams.get("prefix");

      if (key) {
        const value = await store.get(key);
        return new Response(JSON.stringify({ value }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (prefix !== null) {
        const { blobs } = await store.list({ prefix });
        return new Response(JSON.stringify({ keys: blobs.map((b) => b.key) }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "key or prefix required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!body.key) {
        return new Response(JSON.stringify({ error: "key required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      await store.set(body.key, body.value ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/kv",
};
