// Loads the starter questions into MongoDB. Safe to re-run: matches on the question text and never overwrites edits.
//   npm run seed
const faqs = require("../seed/faqs.json");
const { db, close } = require("../src/db");

(async () => {
  const col = (await db()).collection("faqs");
  let added = 0;
  for (const [i, f] of faqs.entries()) {
    const r = await col.updateOne({ q: f.q }, { $setOnInsert: { ...f, order: i + 1, published: true } }, { upsert: true });
    added += r.upsertedCount;
  }
  console.log(`Done. ${added} added, ${faqs.length - added} already present.`);
  await close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
