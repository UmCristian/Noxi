export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
export const EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'pdf',
  'doc',
  'docx',
  'txt',
  'md',
  'markdown',
  'json',
  'xls',
  'xlsx',
  'csv',
  'tsv',
  'ppt',
  'pptx',
  'rtf',
  'odt',
  'xml',
  'yaml',
  'yml',
  'py',
  'js',
  'css',
  'html',
];
export const extension = (name) => String(name).split('.').pop().toLowerCase();
export function validateFile(file, maxBytes = MAX_FILE_BYTES) {
  if (!EXTENSIONS.includes(extension(file.name)))
    throw new Error(`Unsupported format: ${file.name}`);
  if (!file.size || file.size > maxBytes)
    throw new Error(
      `${file.name}: the limit is ${(maxBytes / 1048576).toFixed(2)} MiB per file; empty files are not supported.`,
    );
}
export const fileSize = (size) =>
  size < 1024
    ? `${size || 0} B`
    : size < 1048576
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1048576).toFixed(1)} MB`;
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export function dataURLToBlob(value) {
  const match = /^data:([\w.+/-]*);base64,([A-Za-z0-9+/=\s]*)$/.exec(value);
  if (!match) throw new Error('Invalid backup file.');
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: match[1] || 'application/octet-stream' });
}
