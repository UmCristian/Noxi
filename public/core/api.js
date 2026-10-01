import { getFile, saveChat } from './storage.js';
import { getModel, selectContext } from './models.js';
import { IMAGE_TYPES, extension } from './files.js';

async function checked(response) {
  if (response.ok) return response;
  let error = 'The server is unavailable.';
  try {
    error = (await response.json()).error || error;
  } catch {
    /* non-JSON proxy failure */
  }
  throw new Error(error);
}
export async function prepareMessages(chat, signal, onStatus) {
  const selected = selectContext(chat.messages, chat.settings);
  const model = getModel(chat.settings.model);
  for (const message of selected) {
    for (const attachment of message.attachments || []) {
      const image = Boolean(IMAGE_TYPES[extension(attachment.name)]);
      if (image ? !model.vision : !model.files)
        throw new Error(
          `${model.name} does not support ${image ? 'images' : 'files'}. Choose another model or reduce the context.`,
        );
    }
  }
  const result = [];
  for (const message of selected) {
    const attachments = [];
    for (const attachment of message.attachments || []) {
      if (!attachment.receipt || attachment.expiresAt < Date.now() + 60000) {
        const file = await getFile(attachment.id);
        if (!file?.blob)
          throw new Error(
            `No local copy of “${attachment.name}”. Attach it again or select “Last user turn”.`,
          );
        onStatus(`Uploading ${attachment.name}…`);
        const form = new FormData();
        form.append('file', file.blob, attachment.name);
        const response = await checked(
          await fetch('/api/files', { method: 'POST', body: form, signal }),
        );
        Object.assign(attachment, await response.json());
        await saveChat(chat);
      }
      attachments.push({ receipt: attachment.receipt });
    }
    result.push({ role: message.role, text: message.text, attachments });
  }
  return result;
}
export async function readNDJSON(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        if (line.length > 48 * 1024 * 1024) throw new Error('The result exceeds the local limit.');
        pending = pending.slice(newline + 1);
        if (line.trim()) await onEvent(JSON.parse(line));
      }
      if (pending.length > 48 * 1024 * 1024) throw new Error('The result exceeds the local limit.');
      if (done) break;
    }
    if (pending.trim()) await onEvent(JSON.parse(pending));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function requestResponse(settings, messages, webSearchConfirmed, signal, onEvent) {
  const body = JSON.stringify({ settings, messages, webSearchConfirmed });
  if (new Blob([body]).size > 4 * 1024 * 1024)
    throw new Error('Context exceeds 4 MiB. Reduce the message window.');
  const response = await checked(
    await fetch('/api/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    }),
  );
  await readNDJSON(response.body, onEvent);
}
export async function cleanupRemote(chat) {
  const attachments = [
    ...chat.pendingAttachments,
    ...chat.messages.flatMap((m) => m.attachments || []),
  ];
  const receipts = [
    ...new Set(
      attachments.filter((a) => a.receipt && a.expiresAt > Date.now()).map((a) => a.receipt),
    ),
  ];
  for (let i = 0; i < receipts.length; i += 100)
    await checked(
      await fetch('/api/files/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipts: receipts.slice(i, i + 100) }),
      }),
    );
  attachments.forEach((a) => {
    delete a.receipt;
    delete a.expiresAt;
  });
  await saveChat(chat);
}
