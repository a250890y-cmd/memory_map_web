import { openDB } from 'idb';

const DB_NAME = 'MemoryMapDB';
const STORE_NAME = 'memories';
const DB_VERSION = 1;

export async function initDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp');
      }
    },
  });
}

export async function saveMemory(memory) {
  const db = await initDB();
  return db.add(STORE_NAME, {
    ...memory,
    timestamp: new Date().toISOString()
  });
}

export async function getAllMemories() {
  const db = await initDB();
  return db.getAllFromIndex(STORE_NAME, 'timestamp');
}

export async function updateMemory(memory) {
  const db = await initDB();
  return db.put(STORE_NAME, memory);
}
