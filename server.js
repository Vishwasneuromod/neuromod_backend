// Plain Node HTTP adapter: run anywhere Node runs (VM, Docker, Cloud Run, ECS, Render, Fly...).
//   npm run dev  ->  http://localhost:8787
const path = require("path");
// Load .env next to this file if present (real environment variables always win, so production is unaffected).
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {}
const http = require("http");
const { handle } = require("./src/app");
const config = require("./src/config");

const PORT = process.env.PORT || 8787;
const MAX_BODY = 200 * 1024;

http
  .createServer((req, res) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY && !aborted) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" }).end('{"error":"Body too large"}');
        req.destroy();
      } else if (!aborted) chunks.push(c);
    });
    req.on("end", async () => {
      if (aborted) return;
      const url = new URL(req.url, "http://localhost");
      const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const out = await handle({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers, // Node already lowercases header names
        body: Buffer.concat(chunks).toString("utf8"),
        ip: (config().trustProxy && fwd) || req.socket.remoteAddress || "unknown",
      });
      res.writeHead(out.status, out.headers).end(out.body);
    });
  })
  .listen(PORT, () => {
    console.log(`API listening on :${PORT}`);
    // Say so loudly instead of failing silently later.
    const cfg = config();
    const missing = [
      !process.env.HASHNODE_HOST && "HASHNODE_HOST (blog will return errors)",
      !cfg.mongoUri && "MONGODB_URI (FAQ questions and editor login will not work)",
      cfg.sessionSecret.length < 32 && "SESSION_SECRET, 32+ characters (editor login will not work)",
      !cfg.corsOrigins.length && "CORS_ORIGINS (browsers on another origin will be blocked; fine for local dev with the proxy)",
    ].filter(Boolean);
    missing.forEach((m) => console.warn(`WARNING: ${m} is not set`));
  });
