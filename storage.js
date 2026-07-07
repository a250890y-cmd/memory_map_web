import { db, storage } from './firebase';
import { collection, addDoc, getDocs, updateDoc, doc, query, orderBy, deleteDoc } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL, deleteObject } from 'firebase/storage';

export async function deleteMemory(id, imageUrls = []) {
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

  const docRef = doc(db, 'public_memories', id);
  await deleteDoc(docRef);
}

async function uploadImages(imageUrls) {
  const uploadedUrls = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const dataUrl = imageUrls[i];
    if (dataUrl.startsWith('http')) {
      uploadedUrls.push(dataUrl);
      continue;
    }
    
    const fileName = `public_images/${Date.now()}_${i}.jpg`;
    const imageRef = ref(storage, fileName);
    await uploadString(imageRef, dataUrl, 'data_url');
    const downloadUrl = await getDownloadURL(imageRef);
    uploadedUrls.push(downloadUrl);
  }
  return uploadedUrls;
}

export async function saveMemory(memory) {
  const urls = await uploadImages(memory.imageUrls);
  
  const docData = {
    ...memory,
    imageUrls: urls,
    timestamp: memory.timestamp || new Date().toISOString()
  };
  delete docData.id; 
  
  const memoriesCol = collection(db, 'public_memories');
  const docRef = await addDoc(memoriesCol, docData);
  return docRef.id;
}

export async function getAllMemories() {
  const memoriesCol = collection(db, 'public_memories');
  const q = query(memoriesCol, orderBy('timestamp', 'asc'));
  const snapshot = await getDocs(q);
  
  return snapshot.docs.map(docSnapshot => ({
    id: docSnapshot.id,
    ...docSnapshot.data()
  }));
}

export async function updateMemory(memory) {
  const urls = await uploadImages(memory.imageUrls);
  
  const docData = {
    ...memory,
    imageUrls: urls
  };
  const memoryId = docData.id;
  delete docData.id;
  
  const docRef = doc(db, 'public_memories', memoryId);
  await updateDoc(docRef, docData);
}
