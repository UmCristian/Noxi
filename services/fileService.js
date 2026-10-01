import { createHmac, timingSafeEqual } from 'node:crypto';
import { extension, IMAGE_TYPES, validateFile } from '../public/core/files.js';
import { httpError } from './requestService.js';

function signature(payload) {
  return createHmac('sha256', process.env.OPENAI_API_KEY || 'unconfigured')
    .update(payload)
    .digest('base64url');
}
export function signFile(file) {
  const payload = Buffer.from(JSON.stringify(file)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
export function verifyFile(receipt) {
  if (typeof receipt !== 'string' || receipt.length > 2000)
    throw httpError('Invalid file reference. Attach the file again.');
  const [payload, mac] = receipt.split('.');
  const expected = signature(payload || '');
  if (
    !mac ||
    mac.length !== expected.length ||
    !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  )
    throw httpError('Invalid file reference.');
  let file;
  try {
    file = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    throw httpError('Invalid reference.');
  }
  if (!/^file-[\w-]+$/.test(file.id) || file.expiresAt < Date.now())
    throw httpError('The remote file expired. Send again to upload the local copy.', 410);
  return file;
}
export function inspectUpload(file) {
  if (!file) throw httpError('Select a file.');
  validateFile({ name: file.originalname, size: file.size });
  const ext = extension(file.originalname);
  const b = file.buffer;
  const hex = b.subarray(0, 8).toString('hex');
  const signatures = {
    png: hex === '89504e470d0a1a0a',
    jpg: hex.startsWith('ffd8ff'),
    jpeg: hex.startsWith('ffd8ff'),
    gif: b
      .subarray(0, 6)
      .toString()
      .match(/^GIF8[79]a$/),
    webp: b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
    pdf: b.subarray(0, 1024).includes(Buffer.from('%PDF-')),
    docx: hex.startsWith('504b0304'),
    xlsx: hex.startsWith('504b0304'),
    pptx: hex.startsWith('504b0304'),
    odt: hex.startsWith('504b0304'),
    doc: hex === 'd0cf11e0a1b11ae1',
    xls: hex === 'd0cf11e0a1b11ae1',
    ppt: hex === 'd0cf11e0a1b11ae1',
  };
  if (ext in signatures && !signatures[ext])
    throw httpError('The file contents do not match its extension.');
  if (!(ext in signatures) && b.subarray(0, 8192).includes(0))
    throw httpError('The text file contains binary data.');
  return {
    name: file.originalname.replace(/[\\/\r\n\x00-\x1f]/g, '_').slice(-180),
    image: Boolean(IMAGE_TYPES[ext]),
    type: IMAGE_TYPES[ext] || 'application/octet-stream',
  };
}
