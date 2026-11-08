// The whole API as one function: handle({ method, path, headers, query, body, ip }) -> { status, headers, body }.
// Knows nothing about Node's http, Lambda or Netlify; see server.js and lambda.js for the adapters.
const config = require("./config");
const { json, parseBody, corsHeaders, preflightHeaders } = require("./http");
const auth = require("./auth");
const faq = require("./faq");
const blogHandler = require("./blog").handler;

const wrap = (r) => json(r.status, r.body, r.cache);

async function dispatch(req, cfg) {
  const { method, path, query, headers, ip } = req;

  if (path === "/healthz") return json(200, { ok: true });

  if (method === "GET" && path === "/api/blog") {
    const r = await blogHandler({ queryStringParameters: query });
    return { status: r.statusCode, headers: r.headers, body: r.body };
  }

  if (method === "GET" && path === "/api/faq") return wrap(await faq.listPublic());

  if (method === "POST" && path === "/api/auth/login") {
    const b = parseBody(req.body);
    const r = await auth.login(b.username, b.password, ip);
    if (r.ok) return json(200, { token: r.token, expiresInHours: r.expiresInHours });
    return json(r.status, { error: r.status === 429 ? "Too many attempts. Try again in 15 minutes." : "Incorrect username or password" });
  }

  // Everything under /api/faq/admin needs a logged-in editor.
  if (path === "/api/faq/admin" || path.startsWith("/api/faq/admin/")) {
    const editor = await auth.authenticate(headers);
    if (!editor) return json(401, { error: "Please log in" });
    const rest = path.slice("/api/faq/admin".length).replace(/^\//, "");

    if (!rest && method === "GET") return wrap(await faq.listAll());
    if (!rest && method === "POST") return wrap(await faq.create(parseBody(req.body), editor));
    if (rest === "reorder" && method === "POST") return wrap(await faq.reorder(parseBody(req.body), editor));
    if (rest && !rest.includes("/") && method === "PUT") return wrap(await faq.update(rest, parseBody(req.body), editor));
    if (rest && !rest.includes("/") && method === "DELETE") return wrap(await faq.remove(rest));
  }

  return json(404, { error: "Not found" });
}

async function handle(req) {
  const cfg = config();
  req = { ...req, headers: req.headers || {}, query: req.query || {} };
  const origin = req.headers.origin;

  if (req.method === "OPTIONS") {
    const allowed = origin && cfg.corsOrigins.includes(origin);
    return { status: allowed ? 204 : 403, headers: allowed ? { ...corsHeaders(origin, cfg.corsOrigins), ...preflightHeaders, Vary: "Origin" } : { Vary: "Origin" }, body: "" };
  }

  let res;
  try {
    res = await dispatch(req, cfg);
  } catch (err) {
    if (err.status === 400 || err.status === 413) res = json(err.status, { error: err.message });
    else {
      console.error(err);
      res = json(500, { error: "Something went wrong" });
    }
  }
  res.headers = { ...res.headers, ...corsHeaders(origin, cfg.corsOrigins), Vary: "Origin", "X-Content-Type-Options": "nosniff" };
  return res;
}

module.exports = { handle };
