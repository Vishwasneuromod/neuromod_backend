const crypto = require("crypto");
const { promisify } = require("util");
const config = require("./config");
const { db } = require("./db");

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const WINDOW_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 12;

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest();
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function requireSecret(cfg) {
  if (cfg.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return cfg.sessionSecret;
}

const USERNAME = /^[a-z0-9._-]{3,32}$/;
const normalizeUsername = (u) => (typeof u === "string" ? u.trim().toLowerCase() : "");

// ---------- passwords (scrypt, salted) ----------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(key)}`;
}

async function checkPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const key = await scrypt(password, Buffer.from(salt, "base64url"), 64, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return safeEqual(key, Buffer.from(hash, "base64url"));
}

// Hashed once and reused so an unknown username takes as long as a wrong password (no username discovery by timing).
let dummyHash;
const getDummyHash = () => (dummyHash ||= hashPassword("not-a-real-password"));

// ---------- rate limiting: fixed-window counters in MongoDB, shared across instances ----------
async function hit(key, limit) {
  const doc = await (await db()).collection("rate_limits").findOneAndUpdate(
    { key },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + WINDOW_MS) } },
    { upsert: true, returnDocument: "after" }
  );
  return doc.count <= limit;
}
const reset = async (key) => (await db()).collection("rate_limits").deleteOne({ key });

// ---------- sessions ----------
function signToken(username, cfg) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ sub: username, iat: now, exp: now + cfg.sessionHours * 3600 }));
  return `${payload}.${b64(hmac(requireSecret(cfg), payload))}`;
}

async function login(usernameRaw, password, ip) {
  const cfg = config();
  requireSecret(cfg);
  const username = normalizeUsername(usernameRaw);

  if (!(await hit(`login:ip:${ip}`, 30))) return { ok: false, status: 429 };
  const wellFormed = USERNAME.test(username) && typeof password === "string" && password.length > 0 && password.length <= 256;
  if (wellFormed && !(await hit(`login:user:${username}`, 10))) return { ok: false, status: 429 };

  const user = wellFormed ? await (await db()).collection("editors").findOne({ username }) : null;
  const passwordOk = await checkPassword(wellFormed ? password : "x", user ? user.passwordHash : await getDummyHash());
  if (!user || !passwordOk) return { ok: false, status: 401 };

  await reset(`login:user:${username}`);
  return { ok: true, token: signToken(username, cfg), expiresInHours: cfg.sessionHours };
}

// Returns the username if the Authorization header holds a valid token for an editor who still exists
// and hasn't changed their password since the token was issued. Otherwise null.
async function authenticate(headers) {
  const cfg = config();
  try {
    const secret = requireSecret(cfg);
    const [scheme, token] = (headers.authorization || "").split(" ");
    if (scheme !== "Bearer" || !token) return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig || !safeEqual(Buffer.from(sig), Buffer.from(b64(hmac(secret, payload))))) return null;
    const { sub, iat, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!exp || exp < Date.now() / 1000) return null;
    const user = await (await db()).collection("editors").findOne({ username: sub });
    if (!user || iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) return null;
    return sub;
  } catch {
    return null;
  }
}

// ---------- editor management (used by scripts/editor.js) ----------
// allowWeak lowers the minimum from 12 to 6 characters. Only for sample/dev users: change it before going live.
async function setEditorPassword(usernameRaw, password, { allowWeak = false } = {}) {
  const username = normalizeUsername(usernameRaw);
  if (!USERNAME.test(username)) throw new Error("Username must be 3-32 characters: letters, numbers, . _ -");
  const min = allowWeak ? 6 : MIN_PASSWORD;
  if (typeof password !== "string" || password.length < min || password.length > 256)
    throw new Error(`Password must be at least ${min} characters${allowWeak ? "" : " (use --allow-weak only for sample users)"}`);
  const passwordHash = await hashPassword(password);
  const r = await (await db()).collection("editors").updateOne(
    { username },
    { $set: { passwordHash, passwordChangedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  await reset(`login:user:${username}`);
  return { username, created: r.upsertedCount === 1 };
}

async function removeEditor(usernameRaw) {
  const r = await (await db()).collection("editors").deleteOne({ username: normalizeUsername(usernameRaw) });
  return r.deletedCount === 1;
}

async function listEditors() {
  return (await db()).collection("editors").find({}, { projection: { _id: 0, username: 1, createdAt: 1, passwordChangedAt: 1 } }).sort({ username: 1 }).toArray();
}

module.exports = { login, authenticate, setEditorPassword, removeEditor, listEditors };
