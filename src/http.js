const json = (status, body, cache = "no-store") => ({
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": cache },
  body: JSON.stringify(body),
});

const MAX_BODY = 100 * 1024;

function parseBody(raw) {
  if (!raw) return {};
  if (raw.length > MAX_BODY) throw Object.assign(new Error("Body too large"), { status: 413 });
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

// CORS: exact-match allowlist. Auth uses an Authorization header (not cookies), so no credentials mode is needed.
function corsHeaders(origin, allowed) {
  if (!origin || !allowed.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin };
}

const preflightHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

module.exports = { json, parseBody, corsHeaders, preflightHeaders };
