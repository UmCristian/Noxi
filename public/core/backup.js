import { normalizeSettings } from './models.js';
import { blobToDataURL, dataURLToBlob } from './files.js';
import { getFiles } from './storage.js';

const text = (value, max = 2000000) => (typeof value === 'string' ? value.slice(0, max) : '');
export function newChat(settings) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    settings: normalizeSettings(settings),
    messages: [],
    pendingAttachments: [],
    draft: '',
  };
}
function cleanAttachment(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid file reference in the backup.');
  return {
    id: text(value.id, 100) || crypto.randomUUID(),
    name: text(value.name || value.originalName, 200) || 'file',
    type: text(value.type || value.mimeType, 100) || 'application/octet-stream',
    size: Number(value.size) || 0,
    source: value.source === 'generated' ? 'generated' : 'input',
  };
}
export function cleanChat(value) {
  if (!value || !Array.isArray(value.messages))
    throw new Error('The file does not contain a recognized conversation.');
  const chat = newChat();
  chat.title = text(value.title, 160) || chat.title;
  chat.settings = normalizeSettings(value.settings || value);
  chat.createdAt = text(value.createdAt, 60) || chat.createdAt;
  chat.draft = text(value.draft);
  chat.messages = value.messages
    .filter((m) => m && ['user', 'assistant', 'system', 'developer'].includes(m.role))
    .map((m) => ({
      id: crypto.randomUUID(),
      role: m.role,
      text: text(m.text ?? m.content),
      createdAt: text(m.createdAt, 60),
      status: ['streaming', 'preparing'].includes(m.status)
        ? 'interrupted'
        : ['complete', 'cancelled', 'error', 'interrupted', 'incomplete'].includes(m.status)
          ? m.status
          : 'complete',
      model: text(m.model, 100),
      usage: m.usage
        ? {
            input_tokens: Number(m.usage.input_tokens) || 0,
            output_tokens: Number(m.usage.output_tokens) || 0,
            total_tokens: Number(m.usage.total_tokens) || 0,
            input_tokens_details: {
              cached_tokens: Number(m.usage.input_tokens_details?.cached_tokens) || 0,
            },
          }
        : null,
      attachments: (Array.isArray(m.attachments) ? m.attachments : []).map(cleanAttachment),
      artifacts: (Array.isArray(m.artifacts) ? m.artifacts : []).map((a) => ({
        ...cleanAttachment(a),
        source: 'generated',
      })),
      citations: (Array.isArray(m.citations) ? m.citations : [])
        .filter((c) => c && /^https?:\/\//i.test(c.url))
        .map((c) => ({ url: text(c.url, 4000), title: text(c.title, 500) })),
    }));
  chat.pendingAttachments = (
    Array.isArray(value.pendingAttachments) ? value.pendingAttachments : []
  ).map(cleanAttachment);
  return chat;
}
export async function makeBackup(chats) {
  const exported = [];
  for (const original of chats) {
    const chat = cleanChat(original);
    chat.id = original.id;
    const files = await getFiles(original.id);
    exported.push({
      ...chat,
      files: await Promise.all(
        files.map(async (file) => ({ id: file.id, data: await blobToDataURL(file.blob) })),
      ),
    });
  }
  return { format: 'chatgui', version: 2, exportedAt: new Date().toISOString(), chats: exported };
}
export function parseBackup(value) {
  if (value?.format && (value.format !== 'chatgui' || ![1, 2].includes(value.version)))
    throw new Error('Unsupported backup format or version.');
  const values = Array.isArray(value) ? value : Array.isArray(value?.chats) ? value.chats : [value];
  if (!values.length || values.length > 1000)
    throw new Error('The backup must contain between 1 and 1000 conversations.');
  return values.map((original) => {
    const chat = cleanChat(original);
    const fileMap = new Map();
    for (const message of [...chat.messages, { attachments: chat.pendingAttachments }]) {
      for (const attachment of [...(message.attachments || []), ...(message.artifacts || [])]) {
        const oldId = attachment.id;
        if (!fileMap.has(oldId)) fileMap.set(oldId, crypto.randomUUID());
        attachment.id = fileMap.get(oldId);
      }
    }
    const seen = new Set();
    const files = (Array.isArray(original.files) ? original.files : [])
      .filter((file) => fileMap.has(file.id) && !seen.has(file.id) && seen.add(file.id))
      .map((file) => ({
        id: fileMap.get(file.id),
        chatId: chat.id,
        blob: dataURLToBlob(file.data),
      }));
    return { chat, files };
  });
}
export function plainExport(chat) {
  return (
    `# ${chat.title}\n\nModel: ${chat.settings.model}\n\n## Developer\n\n${chat.settings.systemPrompt}\n\n` +
    chat.messages
      .map(
        (m) =>
          `## ${m.role}\n\n${m.text}\n\n${[...(m.attachments || []), ...(m.artifacts || [])].map((a) => `[File: ${a.name}]`).join('\n')}`,
      )
      .join('\n\n')
  );
}
