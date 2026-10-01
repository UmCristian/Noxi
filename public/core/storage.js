const DB_NAME = 'chatgui';
let connection;
export function openDatabase() {
  connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('chats', { keyPath: 'id' });
      const files = db.createObjectStore('attachments', { keyPath: 'id' });
      files.createIndex('chatId', 'chatId');
      db.createObjectStore('preferences', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(new Error('Could not open IndexedDB. Check your browser storage permissions.'));
    request.onblocked = () => reject(new Error('Close other Noxi tabs to update storage.'));
  });
  return connection;
}
async function transaction(stores, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode, { durability: 'strict' });
    let result;
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror = tx.onabort = () =>
      reject(tx.error || new Error('Could not save. Export a backup and check available storage.'));
    try {
      result = action(tx);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}
export const listChats = () =>
  transaction(['chats'], 'readonly', (tx) => tx.objectStore('chats').getAll());
export const getFile = (id) =>
  transaction(['attachments'], 'readonly', (tx) => tx.objectStore('attachments').get(id));
export const getFiles = (chatId) =>
  transaction(['attachments'], 'readonly', (tx) =>
    tx.objectStore('attachments').index('chatId').getAll(chatId),
  );
export const getPreference = (id) =>
  transaction(['preferences'], 'readonly', (tx) => tx.objectStore('preferences').get(id));
export const setPreference = (id, value) =>
  transaction(['preferences'], 'readwrite', (tx) =>
    tx.objectStore('preferences').put({ id, value }),
  );
// Messages and settings are one atomic chat document; binary data lives separately.
export function saveChat(chat, files = [], deletedFileIds = []) {
  const snapshot = structuredClone(chat);
  return transaction(['chats', 'attachments'], 'readwrite', (tx) => {
    tx.objectStore('chats').put(snapshot);
    for (const file of files) tx.objectStore('attachments').put(file);
    for (const id of deletedFileIds) tx.objectStore('attachments').delete(id);
  });
}
export async function deleteChat(id) {
  const files = await getFiles(id);
  return transaction(['chats', 'attachments'], 'readwrite', (tx) => {
    tx.objectStore('chats').delete(id);
    files.forEach((file) => tx.objectStore('attachments').delete(file.id));
  });
}
export function importRecords(records) {
  return transaction(['chats', 'attachments'], 'readwrite', (tx) => {
    for (const { chat, files } of records) {
      tx.objectStore('chats').add(chat);
      files.forEach((file) => tx.objectStore('attachments').add(file));
    }
  });
}
export async function requestPersistence() {
  try {
    return await navigator.storage?.persist?.();
  } catch {
    return false;
  }
}
