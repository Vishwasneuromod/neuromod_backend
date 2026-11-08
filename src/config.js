// All configuration comes from environment variables, read on each call so tests can change them.
const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

module.exports = function config() {
  const env = process.env;
  return {
    mongoUri: env.MONGODB_URI,
    mongoDb: env.MONGODB_DB || "neuromod",
    // Exact origins allowed to call this API from a browser, e.g. https://neuromod.in,https://www.neuromod.in
    corsOrigins: list(env.CORS_ORIGINS),
    sessionSecret: env.SESSION_SECRET || "",
    sessionHours: Number(env.SESSION_HOURS) || 8,
    trustProxy: env.TRUST_PROXY === "true", // read client IP from X-Forwarded-For (set true behind a load balancer)
  };
};
