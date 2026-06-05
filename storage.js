import { openDB } from 'idb';
import { db, storage, auth } from './firebase';
import { collection, addDoc, getDocs, updateDoc, doc, query, orderBy, deleteDoc } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL, deleteObject } from 'firebase/storage';

export async function deleteMemory(id, imageUrls = []) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not logged in");
  
  for (const url of imageUrls) {
    if (url.includes('firebasestorage')) {
      try {
        const imageRef = ref(storage, url);
        await deleteObject(imageRef);
      } catch(e) {
        console.error("Error deleting image:", e);
      }
    }
  }

  const docRef = doc(db, 'users', user.uid, 'memories', id);
  await deleteDoc(docRef);
}

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

async function uploadImages(imageUrls) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not logged in");
  
  const uploadedUrls = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const dataUrl = imageUrls[i];
    if (dataUrl.startsWith('http')) {
      uploadedUrls.push(dataUrl);
      continue;
    }
    
    // Extract base64 part just in case, but uploadString handles data_url
    const fileName = `images/${user.uid}/${Date.now()}_${i}.jpg`;
    const imageRef = ref(storage, fileName);
    await uploadString(imageRef, dataUrl, 'data_url');
    const downloadUrl = await getDownloadURL(imageRef);
    uploadedUrls.push(downloadUrl);
  }
  return uploadedUrls;
}

export async function saveMemory(memory) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not logged in");

  const urls = await uploadImages(memory.imageUrls);
  
  const docData = {
    ...memory,
    imageUrls: urls,
    timestamp: memory.timestamp || new Date().toISOString()
  };
  delete docData.id; 
  
  const memoriesCol = collection(db, 'users', user.uid, 'memories');
  const docRef = await addDoc(memoriesCol, docData);
  return docRef.id;
}

export async function getAllMemories() {
  const user = auth.currentUser;
  if (!user) return [];
  
  const memoriesCol = collection(db, 'users', user.uid, 'memories');
  const q = query(memoriesCol, orderBy('timestamp', 'asc'));
  const snapshot = await getDocs(q);
  
  return snapshot.docs.map(docSnapshot => ({
    id: docSnapshot.id,
    ...docSnapshot.data()
  }));
}

export async function updateMemory(memory) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not logged in");

  const urls = await uploadImages(memory.imageUrls);
  
  const docData = {
    ...memory,
    imageUrls: urls
  };
  const memoryId = docData.id;
  delete docData.id;
  
  const docRef = doc(db, 'users', user.uid, 'memories', memoryId);
  await updateDoc(docRef, docData);
}

export async function migrateLocalData() {
  const user = auth.currentUser;
  if (!user) return;
  
  try {
    const localDb = await initDB();
    const localMemories = await localDb.getAll(STORE_NAME);
    if (!localMemories || localMemories.length === 0) return;
    
    console.log("Found local memories to migrate: ", localMemories.length);
    for (const mem of localMemories) {
      if (mem.imageUrl && !mem.imageUrls) mem.imageUrls = [mem.imageUrl];
      if (!mem.imageUrls) mem.imageUrls = [];
      await saveMemory(mem);
      await localDb.delete(STORE_NAME, mem.id);
    }
    console.log("Migration complete!");
  } catch (err) {
    console.error("Migration error: ", err);
  }
}
