import { MongoClient, Db } from 'mongodb';

let client: MongoClient | null = null;
let db: Db | null = null;

/** Lazy singleton — connects once and reuses the connection */
export async function connectDB(): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is not set');

  const dbName = process.env.DB_NAME || 'digital_banking';

  client = new MongoClient(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  await client.connect();
  db = client.db(dbName);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    if (client) await client.close();
    console.log('MongoDB connection closed.');
    process.exit(0);
  });

  return db;
}

/** Use this everywhere inside route handlers */
export async function getDB(): Promise<Db> {
  return db ?? connectDB();
}

export function getClient(): MongoClient | null {
  return client;
}
