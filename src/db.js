const { MongoClient } = require("mongodb");
const config = require("./config");

// One client per process, reused across requests (important on serverless: avoids reconnecting every call).
let clientPromise;
let indexesReady;

async function db() {
  const cfg = config();
  if (!cfg.mongoUri) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    clientPromise = new MongoClient(cfg.mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .catch((err) => {
        clientPromise = undefined;
        throw err;
      });
  }
  const database = (await clientPromise).db(cfg.mongoDb);
  if (!indexesReady) {
    indexesReady = Promise.all([
      database.collection("faqs").createIndex({ order: 1 }),
      database.collection("editors").createIndex({ username: 1 }, { unique: true }),
      database.collection("rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]).catch((err) => {
      indexesReady = undefined;
      throw err;
    });
  }
  await indexesReady;
  return database;
}

async function close() {
  if (clientPromise) await (await clientPromise).close();
  clientPromise = undefined;
  indexesReady = undefined;
}

module.exports = { db, close };
