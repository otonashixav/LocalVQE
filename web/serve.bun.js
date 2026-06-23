// Static file server for the LocalVQE web demo, via Bun.
//
//   bun web/serve.bun.js            # binds 0.0.0.0:3000 (all interfaces)
//   PORT=8080 bun web/serve.bun.js
//
// Single-threaded WASM demo: no COOP/COEP cross-origin-isolation headers
// needed. Bun infers content types from the extension (incl. application/wasm).
import { join, normalize } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname; // the web/ directory
const PORT = Number(process.env.PORT) || 3000;

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/") path = "/index.html";
    // normalize() collapses any ".." (leading "/" keeps it from escaping ROOT)
    const rel = normalize(path).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = Bun.file(join(ROOT, rel));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "Cache-Control": "no-cache" } });
  },
});

console.log(`LocalVQE demo → http://0.0.0.0:${server.port}  (all interfaces)`);
