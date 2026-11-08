const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod, handle, auth, closeDb, dbFn;
const ORIGIN = "https://neuromod.in";
const EDITOR = "dr.vishwas";
const PASSWORD = "correct horse battery";

const call = async (method, path, { body, token, origin, ip = "1.1.1.1" } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const r = await handle({ method, path, headers, query: {}, body: body ? JSON.stringify(body) : "", ip });
  return { ...r, json: r.body ? JSON.parse(r.body) : null };
};
const login = async (ip, username = EDITOR, password = PASSWORD) =>
  call("POST", "/api/auth/login", { body: { username, password }, ip });
const tokenFor = async (ip) => (await login(ip)).json.token;

before(async () => {
  mongod = await MongoMemoryServer.create();
  Object.assign(process.env, {
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "test",
    SESSION_SECRET: "x".repeat(40),
    CORS_ORIGINS: `${ORIGIN},https://www.neuromod.in`,
  });
  ({ handle } = require("../src/app"));
  auth = require("../src/auth");
  ({ close: closeDb, db: dbFn } = require("../src/db"));
});
after(async () => {
  await closeDb();
  await mongod.stop();
});
beforeEach(async () => {
  const d = await dbFn();
  await Promise.all(["faqs", "editors", "rate_limits"].map((c) => d.collection(c).deleteMany({})));
  await auth.setEditorPassword(EDITOR, PASSWORD);
});

test("public FAQ returns only published questions, in order, without ids", async () => {
  const d = await dbFn();
  await d.collection("faqs").insertMany([
    { q: "B", a: "b", order: 2, published: true },
    { q: "A", a: "a", order: 1, published: true },
    { q: "Hidden", a: "h", order: 3, published: false },
  ]);
  const r = await call("GET", "/api/faq");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.faqs.map((f) => f.q), ["A", "B"]);
  assert.equal(r.json.faqs[0].id, undefined);
});

test("correct username and password logs in (username is case-insensitive)", async () => {
  const r = await login("1.1.1.1", "  Dr.Vishwas ", PASSWORD);
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
});

test("wrong password and unknown user get the identical generic error", async () => {
  const wrong = await login("1.1.1.2", EDITOR, "not the password!!");
  const unknown = await login("1.1.1.3", "nobody.here", PASSWORD);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.json, unknown.json);
});

test("malformed login bodies are rejected without crashing", async () => {
  for (const body of [{}, { username: EDITOR }, { password: PASSWORD }, { username: { $ne: 1 }, password: { $ne: 1 } }, { username: EDITOR, password: "x".repeat(300) }]) {
    const r = await call("POST", "/api/auth/login", { body });
    assert.equal(r.status, 401);
  }
});

test("password is stored hashed, never in plain text", async () => {
  const d = await dbFn();
  const doc = await d.collection("editors").findOne({ username: EDITOR });
  assert.match(doc.passwordHash, /^scrypt\$/);
  assert.ok(!JSON.stringify(doc).includes(PASSWORD));
});

test("too many wrong passwords locks the username (even for the right password) until the window passes", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login(`7.7.7.${i}`, EDITOR, "wrong password!!")).status, 401);
  assert.equal((await login("7.7.7.99")).status, 429);
  const d = await dbFn();
  await d.collection("rate_limits").deleteMany({});
  assert.equal((await login("7.7.7.99")).status, 200);
});

test("a successful login resets the failed-attempt counter", async () => {
  for (let i = 0; i < 6; i++) await login("6.6.6.6", EDITOR, "wrong password!!");
  assert.equal((await login("6.6.6.6")).status, 200);
  for (let i = 0; i < 6; i++) assert.equal((await login("6.6.6.6", EDITOR, "wrong password!!")).status, 401);
});

test("one IP is limited overall (429)", async () => {
  let status = 401;
  for (let i = 0; i < 32; i++) status = (await login("8.8.8.8", `user${i}`, "whatever password")).status;
  assert.equal(status, 429);
});

test("password rules enforced when creating editors", async () => {
  await assert.rejects(auth.setEditorPassword("newperson", "short"), /at least 12/);
  await assert.rejects(auth.setEditorPassword("bad name!", "long enough password"), /Username/);
});

test("admin endpoints reject missing, garbage and tampered tokens", async () => {
  assert.equal((await call("GET", "/api/faq/admin")).status, 401);
  assert.equal((await call("GET", "/api/faq/admin", { token: "abc.def" })).status, 401);
  const token = await tokenFor("2.2.2.2");
  const [p, s] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: EDITOR, exp: 9999999999 })).toString("base64url");
  assert.equal((await call("GET", "/api/faq/admin", { token: `${forged}.${s}` })).status, 401);
  assert.equal((await call("GET", "/api/faq/admin", { token })).status, 200);
});

test("token stops working once the editor is removed", async () => {
  const token = await tokenFor("3.3.3.3");
  assert.equal((await call("GET", "/api/faq/admin", { token })).status, 200);
  assert.equal(await auth.removeEditor(EDITOR), true);
  assert.equal((await call("GET", "/api/faq/admin", { token })).status, 401);
});

test("changing the password signs out existing sessions; new password works, old one doesn't", async () => {
  const token = await tokenFor("3.3.3.4");
  await new Promise((r) => setTimeout(r, 1100)); // token iat has 1-second resolution
  await auth.setEditorPassword(EDITOR, "a brand new password");
  assert.equal((await call("GET", "/api/faq/admin", { token })).status, 401);
  assert.equal((await login("3.3.3.5")).status, 401);
  assert.equal((await login("3.3.3.5", EDITOR, "a brand new password")).status, 200);
});

test("expired token is rejected", async () => {
  process.env.SESSION_HOURS = "-1";
  const token = await tokenFor("3.3.3.6");
  delete process.env.SESSION_HOURS;
  assert.equal((await call("GET", "/api/faq/admin", { token })).status, 401);
});

test("editor can create, edit, hide, reorder and delete questions", async () => {
  const token = await tokenFor("4.4.4.4");
  const a = (await call("POST", "/api/faq/admin", { token, body: { q: " First? ", a: "One", to: "/services/epilepsy" } })).json.faq;
  const b = (await call("POST", "/api/faq/admin", { token, body: { q: "Second?", a: "Two" } })).json.faq;
  assert.equal(a.q, "First?");
  assert.ok(b.order > a.order);

  const upd = await call("PUT", `/api/faq/admin/${b.id}`, { token, body: { a: "Two, edited", published: false } });
  assert.equal(upd.json.faq.a, "Two, edited");
  assert.deepEqual((await call("GET", "/api/faq")).json.faqs.map((f) => f.q), ["First?"]); // hidden one not public

  await call("POST", "/api/faq/admin/reorder", { token, body: { ids: [b.id, a.id] } });
  assert.deepEqual((await call("GET", "/api/faq/admin", { token })).json.faqs.map((f) => f.q), ["Second?", "First?"]);

  assert.equal((await call("DELETE", `/api/faq/admin/${a.id}`, { token })).status, 200);
  assert.equal((await call("DELETE", `/api/faq/admin/${a.id}`, { token })).status, 404);
  assert.equal((await call("PUT", "/api/faq/admin/not-an-id", { token, body: { q: "x" } })).status, 404);
});

test("input validation: empty, oversized, bad link, wrong types, bad JSON", async () => {
  const token = await tokenFor("5.5.5.5");
  const post = (body) => call("POST", "/api/faq/admin", { token, body });
  assert.equal((await post({ q: "", a: "x" })).status, 400);
  assert.equal((await post({ q: "x".repeat(301), a: "x" })).status, 400);
  assert.equal((await post({ q: "q", a: "x".repeat(5001) })).status, 400);
  assert.equal((await post({ q: "q", a: "a", to: "javascript:alert(1)" })).status, 400);
  assert.equal((await post({ q: "q", a: "a", to: "https://evil.com" })).status, 400);
  assert.equal((await post({ q: { $ne: 1 }, a: "a" })).status, 400);
  const bad = await handle({ method: "POST", path: "/api/faq/admin", headers: { authorization: `Bearer ${token}` }, body: "{nope", ip: "5.5.5.5" });
  assert.equal(bad.status, 400);
});

test("CORS: allowed origin gets headers, others don't; preflight handled", async () => {
  const ok = await call("GET", "/api/faq", { origin: ORIGIN });
  assert.equal(ok.headers["Access-Control-Allow-Origin"], ORIGIN);
  assert.equal(ok.headers.Vary, "Origin");
  const evil = await call("GET", "/api/faq", { origin: "https://evil.com" });
  assert.equal(evil.headers["Access-Control-Allow-Origin"], undefined);
  const subdomainTrick = await call("GET", "/api/faq", { origin: "https://neuromod.in.evil.com" });
  assert.equal(subdomainTrick.headers["Access-Control-Allow-Origin"], undefined);

  const pre = await call("OPTIONS", "/api/faq/admin", { origin: ORIGIN });
  assert.equal(pre.status, 204);
  assert.match(pre.headers["Access-Control-Allow-Headers"], /Authorization/);
  assert.match(pre.headers["Access-Control-Allow-Methods"], /DELETE/);
  assert.equal((await call("OPTIONS", "/api/faq/admin", { origin: "https://evil.com" })).status, 403);
});

test("unknown routes 404, health works", async () => {
  assert.equal((await call("GET", "/api/nope")).status, 404);
  assert.equal((await call("GET", "/healthz")).status, 200);
});
