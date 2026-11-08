const { ObjectId } = require("mongodb");
const { db } = require("./db");

const PUBLIC_FIELDS = { _id: 0, q: 1, a: 1, to: 1 };
const col = async () => (await db()).collection("faqs");
const bad = (error) => ({ status: 400, body: { error } });

// Public: published questions only, in order.
async function listPublic() {
  const docs = await (await col()).find({ published: { $ne: false } }, { projection: PUBLIC_FIELDS }).sort({ order: 1, _id: 1 }).toArray();
  return { status: 200, body: { faqs: docs }, cache: "public, max-age=60, s-maxage=300, stale-while-revalidate=600" };
}

// Editors: everything, including hidden ones.
async function listAll() {
  const docs = await (await col()).find({}).sort({ order: 1, _id: 1 }).toArray();
  return { status: 200, body: { faqs: docs.map(({ _id, ...f }) => ({ id: String(_id), ...f })) } };
}

// Validates and trims editor input. Answers are stored and shown as plain text, never HTML.
function clean(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.q !== undefined) {
    if (typeof input.q !== "string" || !input.q.trim() || input.q.length > 300) return { error: "Question is required (max 300 characters)" };
    out.q = input.q.trim();
  }
  if (!partial || input.a !== undefined) {
    if (typeof input.a !== "string" || !input.a.trim() || input.a.length > 5000) return { error: "Answer is required (max 5000 characters)" };
    out.a = input.a.trim();
  }
  if (input.to !== undefined) {
    if (input.to !== "" && !(typeof input.to === "string" && /^\/[a-z0-9/_-]*$/i.test(input.to) && input.to.length <= 100))
      return { error: "Link must be a site path like /services/epilepsy, or empty" };
    out.to = input.to || null;
  }
  if (input.published !== undefined) {
    if (typeof input.published !== "boolean") return { error: "published must be true or false" };
    out.published = input.published;
  }
  return { value: out };
}

const toId = (s) => (ObjectId.isValid(s) && String(new ObjectId(s)) === s ? new ObjectId(s) : null);

async function create(input, editor) {
  const { value, error } = clean(input);
  if (error) return bad(error);
  const c = await col();
  const last = await c.find({}, { projection: { order: 1 } }).sort({ order: -1 }).limit(1).toArray();
  const doc = { to: null, published: true, ...value, order: (last[0]?.order || 0) + 1, updatedAt: new Date(), updatedBy: editor };
  const { insertedId } = await c.insertOne(doc);
  const { _id, ...rest } = doc;
  return { status: 201, body: { faq: { id: String(insertedId), ...rest } } };
}

async function update(id, input, editor) {
  const _id = toId(id);
  if (!_id) return { status: 404, body: { error: "Not found" } };
  const { value, error } = clean(input, { partial: true });
  if (error) return bad(error);
  const doc = await (await col()).findOneAndUpdate(
    { _id },
    { $set: { ...value, updatedAt: new Date(), updatedBy: editor } },
    { returnDocument: "after" }
  );
  if (!doc) return { status: 404, body: { error: "Not found" } };
  const { _id: oid, ...rest } = doc;
  return { status: 200, body: { faq: { id: String(oid), ...rest } } };
}

async function remove(id) {
  const _id = toId(id);
  if (!_id) return { status: 404, body: { error: "Not found" } };
  const r = await (await col()).deleteOne({ _id });
  return r.deletedCount ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "Not found" } };
}

// body: { ids: [id, id, ...] } in the desired order
async function reorder(input, editor) {
  const ids = Array.isArray(input.ids) ? input.ids.map(toId) : [];
  if (!ids.length || ids.length > 500 || ids.includes(null)) return bad("ids must be a list of question ids");
  await (await col()).bulkWrite(
    ids.map((_id, i) => ({ updateOne: { filter: { _id }, update: { $set: { order: i + 1, updatedAt: new Date(), updatedBy: editor } } } }))
  );
  return { status: 200, body: { ok: true } };
}

module.exports = { listPublic, listAll, create, update, remove, reorder };
