import * as storage from './core/storage.js';
import { MODELS, getModel, normalizeSettings } from './core/models.js';
import { newChat, makeBackup, parseBackup, plainExport } from './core/backup.js';
import {
  EXTENSIONS,
  IMAGE_TYPES,
  extension,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  validateFile,
  dataURLToBlob,
} from './core/files.js';
import { prepareMessages, requestResponse, cleanupRemote } from './core/api.js';
import {
  element,
  button,
  messageCard,
  attachmentCard,
  clearPreviews,
  renderMarkdown,
  download,
} from './core/render.js';
import { estimateCost } from './core/usage.js';
const $ = (id) => document.getElementById(id);
const state = {
  chats: [],
  current: null,
  busy: false,
  controller: null,
  writable: false,
  editId: null,
  config: {
    models: MODELS,
    defaultSettings: normalizeSettings(),
    maxFileBytes: MAX_FILE_BYTES,
    maxAttachments: MAX_ATTACHMENTS,
  },
};

let writeQueue = Promise.resolve();
let saveFailed = false;
let pendingWrites = 0;
function errorNotice(error) {
  $('notice').textContent = error.message || String(error);
  $('notice').hidden = false;
}
function clearNotice() {
  $('notice').hidden = true;
}
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      errorNotice(error);
    }
  };
}
function persist(files = [], deleted = []) {
  const chat = structuredClone(state.current);
  chat.updatedAt = new Date().toISOString();
  state.current.updatedAt = chat.updatedAt;
  $('save-state').textContent = 'Saving…';
  pendingWrites++;
  writeQueue = writeQueue.catch(() => {}).then(() => storage.saveChat(chat, files, deleted));
  return writeQueue
    .then(() => {
      saveFailed = false;
    })
    .catch((error) => {
      saveFailed = true;
      errorNotice(error);
      throw error;
    })
    .finally(() => {
      pendingWrites--;
      $('save-state').textContent = saveFailed ? 'Not saved' : pendingWrites ? 'Saving…' : 'Saved';
    });
}
function setBusy(busy) {
  state.busy = busy;
  for (const control of document.querySelectorAll(
    '.settings input,.settings select,.settings textarea,.settings button:not(#close-settings),#new-chat,#rename,#history-button,#message-input,#attach,#import,#export-all,#logout',
  ))
    control.disabled = busy || !state.writable;
  $('send').hidden = busy;
  $('send').disabled = !state.writable;
  $('stop').hidden = !busy;
  if (!busy && state.current) renderSettings();
  if (!busy)
    $('request-status').textContent = state.editId
      ? 'Editing · sending replaces subsequent messages'
      : 'Attach or drop files';
}
function showSettings(open) {
  $('settings').classList.toggle('open', open);
  $('settings').inert = !open;
  for (const node of document.querySelectorAll('.topbar,.workspace-header,.conversation'))
    node.inert = open;
  if (open) {
    $('settings').setAttribute('role', 'dialog');
    $('settings').setAttribute('aria-modal', 'true');
  } else {
    $('settings').removeAttribute('role');
    $('settings').removeAttribute('aria-modal');
  }
  $('drawer-backdrop').hidden = !open;
  $('settings-button').setAttribute('aria-expanded', String(open));
  if (open)
    requestAnimationFrame(() => {
      if ($('settings').classList.contains('open'))
        $('close-settings').focus({ preventScroll: true });
    });
  else $('settings-button').focus();
}
function openDialog(id) {
  $(id).showModal();
}
async function confirm({ title, description, accept = 'Continue', input, cost = false }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  $('confirm-accept').textContent = accept;
  $('confirm-input-label').hidden = input === undefined;
  $('confirm-input').value = input ?? '';
  dialog.classList.toggle('cost-confirm', cost);
  dialog.returnValue = '';
  dialog.showModal();
  if (input !== undefined) {
    $('confirm-input').focus();
    $('confirm-input').select();
  }
  return new Promise((resolve) => {
    const form = dialog.querySelector('form');
    const finish = (value) => {
      form.removeEventListener('submit', submit);
      dialog.removeEventListener('close', close);
      resolve(value);
    };
    const close = () => finish(false);
    const submit = (event) => {
      event.preventDefault();
      const value =
        event.submitter?.value === 'confirm'
          ? input === undefined
            ? true
            : $('confirm-input').value.trim()
          : false;
      dialog.close();
      finish(value);
    };
    form.addEventListener('submit', submit);
    dialog.addEventListener('close', close);
  });
}
function renderSettings() {
  const s = state.current.settings;
  if (![...$('model').options].some((option) => option.value === s.model)) {
    const option = element('option', '', `${getModel(s.model).name} · saved`);
    option.value = s.model;
    $('model').append(option);
  }
  $('model').value = s.model;
  $('effort').parentElement.hidden = !getModel(s.model).reasoning.length;
  $('verbosity').parentElement.hidden = !getModel(s.model).verbosity;
  $('temperature-field').hidden = !getModel(s.model).temperature;
  $('temperature').value = s.temperature;
  $('effort').replaceChildren(
    ...getModel(s.model).reasoning.map((value) => {
      const option = element('option', '', value);
      option.value = value;
      return option;
    }),
  );
  $('effort').value = s.reasoningEffort;
  $('verbosity').value = s.verbosity;
  $('format').value = s.format;
  $('developer').value = s.systemPrompt;
  $('max-tokens').value = s.maxOutputTokens;
  $('max-tokens').max = getModel(s.model).maxOutput || 128000;
  $('context').value = s.contextStrategy;
  $('window').value = s.contextWindowSize;
  $('window').disabled = s.contextStrategy !== 'window';
  document.querySelectorAll('.tool-option input').forEach((input) => {
    input.checked = s.tools.includes(input.value);
    input.disabled = !getModel(s.model).tools.includes(input.value);
  });
  renderTools();
  renderBlocks();
}
const toolNames = {
  web_search: 'Web Search',
  code_interpreter: 'Code Interpreter',
  image_generation: 'Image Generation',
};
function renderTools() {
  const s = state.current.settings;
  $('tools-toggle').textContent = s.tools.length ? 'custom' : 'off';
  $('tool-chips').replaceChildren(
    ...s.tools.map((tool) => {
      const chip = button(
        `${tool === 'web_search' ? '◎ ' : ''}${toolNames[tool]} ×`,
        guard(async () => {
          if (state.busy) return;
          s.tools = s.tools.filter((t) => t !== tool);
          await persist();
          renderSettings();
        }),
        `tool-chip${tool === 'web_search' ? ' web' : ''}`,
      );
      chip.title = 'Disable tool';
      return chip;
    }),
  );
  $('web-indicator').hidden = !s.tools.includes('web_search');
  $('mobile-summary').textContent =
    `${getModel(s.model).name} · ${s.reasoningEffort} · ${s.tools.includes('web_search') ? 'web ON' : s.tools.length ? 'tools custom' : 'tools off'}`;
  $('model-footnote').textContent = getModel(s.model).name;
}
function renderBlocks() {
  $('blocks-empty').hidden = state.current.settings.promptBlocks.length > 0;
  $('prompt-blocks').replaceChildren(
    ...state.current.settings.promptBlocks.map((block) => {
      const wrapper = element('div', 'prompt-block');
      const header = element('header');
      header.append(
        element('span', '', 'Developer'),
        button(
          '×',
          guard(async () => {
            state.current.settings.promptBlocks = state.current.settings.promptBlocks.filter(
              (b) => b.id !== block.id,
            );
            await persist();
            renderBlocks();
          }),
        ),
      );
      const input = element('textarea');
      input.value = block.text;
      input.placeholder = 'Additional instructions…';
      input.setAttribute('aria-label', 'Instruction block');
      input.oninput = guard(async () => {
        block.text = input.value;
        await persist();
      });
      wrapper.append(header, input);
      return wrapper;
    }),
  );
}
function renderMessages(scroll = true) {
  clearPreviews();
  const messages = state.current.messages;
  $('messages').replaceChildren(
    ...messages.map((message, index) =>
      messageCard(message, {
        edit: guard(editMessage),
        retry:
          index === messages.length - 1 && (message.role === 'assistant' || message.role === 'user')
            ? guard(() => sendMessage('retry'))
            : null,
      }),
    ),
  );
  if (!messages.length) {
    const empty = element('div', 'empty-state');
    empty.append(
      element('span', 'empty-symbol', 'n'),
      element('h1', '', 'A little space to think.'),
      element(
        'p',
        '',
        'Start with a question, a document or an idea. Choose your model and tools in Settings.',
      ),
      element(
        'p',
        'local-note',
        'Conversations stay in this browser. Requests are sent to OpenAI.',
      ),
    );
    $('messages').append(empty);
  }
  renderPending();
  $('rename').textContent = state.current.title;
  const totalCost = messages.reduce((sum, message) => sum + (estimateCost(message) || 0), 0);
  $('usage-total').textContent =
    `${messages.reduce((total, m) => total + (m.usage?.total_tokens || 0), 0).toLocaleString()} tokens${totalCost ? ` · ≈ $${totalCost.toFixed(4)}` : ''}`;
  $('usage-total').title =
    'Estimated token cost in USD; excludes tools. Rates dated September 12, 2026.';
  if (scroll) $('messages').scrollTop = $('messages').scrollHeight;
}
function renderPending() {
  $('pending').replaceChildren(
    ...state.current.pendingAttachments.map((attachment) =>
      attachmentCard(
        attachment,
        guard(async () => {
          if (state.busy) return;
          state.current.pendingAttachments = state.current.pendingAttachments.filter(
            (a) => a.id !== attachment.id,
          );
          await persist([], [attachment.id]);
          renderPending();
        }),
      ),
    ),
  );
  $('message-input').required = !state.current.pendingAttachments.length;
}
async function selectChat(chat) {
  if (state.busy || !chat) return;
  await writeQueue.catch(() => {});
  state.current = chat;
  state.editId = null;
  $('message-input').value = chat.draft || '';
  await storage.setPreference('activeChat', chat.id);
  renderSettings();
  renderMessages();
  setBusy(false);
  clearNotice();
}
async function createChat() {
  if (state.busy) return;
  const chat = newChat(state.config.defaultSettings);
  await storage.saveChat(chat);
  state.chats.unshift(chat);
  await selectChat(chat);
  $('chat-count').textContent = state.chats.length;
  $('message-input').focus();
}
function renderHistory() {
  const query = $('search-chats').value.toLowerCase();
  const chats = state.chats
    .filter(
      (c) =>
        c.title.toLowerCase().includes(query) ||
        c.messages.some((m) => m.text.toLowerCase().includes(query)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('chat-list').replaceChildren(
    ...chats.map((chat) => {
      const row = element('div', `chat-row${chat.id === state.current.id ? ' active' : ''}`);
      const open = button(
        '',
        guard(async () => {
          await selectChat(chat);
          $('history-dialog').close();
        }),
        'chat-open',
      );
      open.append(
        element('strong', '', chat.title),
        element(
          'span',
          '',
          `${getModel(chat.settings.model).name} · ${chat.messages.length} messages · ${new Date(chat.updatedAt).toLocaleDateString()}`,
        ),
      );
      const remove = button(
        '×',
        guard(async () => {
          if (
            !(await confirm({
              title: 'Delete conversation',
              description: `This deletes “${chat.title}” and its local files. This cannot be undone.`,
              accept: 'Delete conversation',
            }))
          )
            return;
          await storage.deleteChat(chat.id);
          state.chats = state.chats.filter((c) => c.id !== chat.id);
          if (state.current.id === chat.id) {
            if (state.chats.length) await selectChat(state.chats[0]);
            else await createChat();
          }
          $('chat-count').textContent = state.chats.length;
          renderHistory();
        }),
        'icon-button',
      );
      remove.setAttribute('aria-label', `Delete ${chat.title}`);
      row.append(open, remove);
      return row;
    }),
  );
  if (!chats.length) $('chat-list').append(element('p', 'muted', 'No matching conversations.'));
}
async function addFiles(files) {
  if (state.busy || !state.writable) return;
  const incoming = [...files];
  if (incoming.length + state.current.pendingAttachments.length > state.config.maxAttachments)
    throw new Error(`You can attach up to ${state.config.maxAttachments} files per message.`);
  incoming.forEach((file) => validateFile(file, state.config.maxFileBytes));
  const records = incoming.map((file) => ({
    id: crypto.randomUUID(),
    chatId: state.current.id,
    blob: file,
  }));
  state.current.pendingAttachments.push(
    ...incoming.map((file, i) => ({
      id: records[i].id,
      name: file.name,
      size: file.size,
      type: IMAGE_TYPES[extension(file.name)] || file.type || 'application/octet-stream',
      source: 'input',
    })),
  );
  await persist(records);
  renderPending();
}
async function editMessage(id) {
  if (state.busy) return;
  const message = state.current.messages.find((m) => m.id === id);
  if (!message) return;
  state.editId = id;
  $('message-input').value = message.text;
  $('request-status').textContent = 'Editing · sending replaces subsequent messages';
  $('message-input').focus();
}
async function sendMessage(mode = 'new') {
  if (state.busy || !state.writable) return;
  const chat = state.current;
  let text = $('message-input').value.trim();
  if (mode === 'new' && !text && !chat.pendingAttachments.length && !state.editId) return;
  if (mode === 'retry' && !chat.messages.some((m) => m.role === 'user')) return;
  setBusy(true);
  clearNotice();
  let assistant;
  let terminal = false;
  try {
    await writeQueue;
    if (saveFailed) throw new Error('Save or export your changes before generating.');
    const web = chat.settings.tools.includes('web_search');
    if (
      web &&
      !(await confirm({
        title: 'Allow paid Web Search?',
        description:
          'Web Search will be available for this request. The model may search automatically and incur additional charges. Continue only if you accept the cost of this request.',
        accept: 'Continue and accept charges',
        cost: true,
      }))
    )
      return;
    if (
      state.editId &&
      mode === 'new' &&
      !(await confirm({
        title: 'Replace from this message?',
        description:
          'The edited message will be kept. Subsequent messages will be removed before generating a new response.',
        accept: 'Edit and generate',
      }))
    )
      return;
    state.controller = new AbortController();
    if (mode === 'retry') {
      const lastUser = chat.messages.findLastIndex((m) => m.role === 'user');
      chat.messages = chat.messages.slice(0, lastUser + 1);
    } else if (state.editId) {
      const index = chat.messages.findIndex((m) => m.id === state.editId);
      chat.messages[index].text = text;
      chat.messages[index].attachments.push(...chat.pendingAttachments);
      chat.messages = chat.messages.slice(0, index + 1);
      state.editId = null;
      chat.pendingAttachments = [];
    } else {
      chat.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        text,
        attachments: chat.pendingAttachments,
        createdAt: new Date().toISOString(),
        status: 'complete',
      });
      chat.pendingAttachments = [];
    }
    if (mode === 'new') {
      chat.draft = '';
      $('message-input').value = '';
    }
    if (['New conversation', 'Nuevo prompt', 'Nuevo chat'].includes(chat.title))
      chat.title = (text || chat.messages.at(-1).text || 'Conversation with files').slice(0, 70);
    const referenced = new Set(
      [
        ...chat.pendingAttachments,
        ...chat.messages.flatMap((m) => [...(m.attachments || []), ...(m.artifacts || [])]),
      ].map((a) => a.id),
    );
    const orphanIds = (await storage.getFiles(chat.id))
      .filter((file) => !referenced.has(file.id))
      .map((file) => file.id);
    await persist([], orphanIds);
    renderMessages();
    $('request-status').textContent = 'Preparing context…';
    const messages = await prepareMessages(
      chat,
      state.controller.signal,
      (status) => ($('request-status').textContent = status),
    );
    assistant = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '',
      model: chat.settings.model,
      status: 'streaming',
      createdAt: new Date().toISOString(),
      attachments: [],
      artifacts: [],
      citations: [],
    };
    chat.messages.push(assistant);
    await persist();
    renderMessages();
    $('request-status').textContent = 'Generating…';
    let lastSave = performance.now();
    await requestResponse(chat.settings, messages, web, state.controller.signal, async (event) => {
      if (event.type === 'error') throw new Error(event.error);
      if (event.type === 'delta') {
        assistant.text += event.text;
        const pane = $('messages');
        const follow = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
        const body = pane.querySelector(`[data-id="${assistant.id}"] .message-body`);
        renderMarkdown(body, assistant.text);
        if (follow) pane.scrollTop = pane.scrollHeight;
        if (performance.now() - lastSave > 250) {
          lastSave = performance.now();
          await persist();
        }
      } else if (event.type === 'tool') {
        $('request-status').textContent =
          `${toolNames[event.tool.replace(/_call$/, '')] || 'Tool'} · ${event.status}`;
      } else if (
        event.type === 'citation' &&
        /^https?:\/\//i.test(event.url) &&
        !assistant.citations.some((c) => c.url === event.url)
      ) {
        assistant.citations.push({ url: event.url, title: event.title });
      } else if (event.type === 'artifact') {
        const blob = dataURLToBlob(`data:${event.mime.split(';')[0]};base64,${event.data}`);
        const artifact = {
          id: crypto.randomUUID(),
          name: event.name,
          size: blob.size,
          type: blob.type,
          source: 'generated',
        };
        assistant.artifacts.push(artifact);
        await persist([{ id: artifact.id, chatId: chat.id, blob }]);
      } else if (event.type === 'artifact-unavailable') {
        assistant.artifacts.push({
          id: crypto.randomUUID(),
          name: event.name,
          source: 'generated',
          size: 0,
        });
        errorNotice(event.error);
      } else if (event.type === 'done') {
        assistant.status = event.status;
        assistant.usage = event.usage;
        assistant.responseId = event.responseId;
        terminal = true;
      }
    });
    if (!terminal)
      throw new Error(
        'The connection closed before completion. The partial response has been saved.',
      );
  } catch (error) {
    const aborted = state.controller?.signal.aborted;
    if (assistant) assistant.status = aborted ? 'cancelled' : 'error';
    if (!aborted) errorNotice(error);
  } finally {
    if (assistant && assistant.status === 'streaming') assistant.status = 'interrupted';
    await persist().catch(() => {});
    state.controller = null;
    setBusy(false);
    renderMessages(false);
  }
}
async function exportJSON(all) {
  await writeQueue;
  const backup = await makeBackup(all ? state.chats : [state.current]);
  download(
    new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
    `noxi-${all ? 'backup' : 'chat'}-${new Date().toISOString().slice(0, 10)}.json`,
  );
  storage.requestPersistence();
}
async function importFiles(files) {
  if (state.busy) return;
  const records = [];
  for (const file of files) {
    if (file.size > 150 * 1024 * 1024)
      throw new Error('The backup exceeds the import limit (150 MiB).');
    const text = await file.text();
    if (extension(file.name) === 'json') records.push(...parseBackup(JSON.parse(text)));
    else {
      const chat = newChat();
      chat.title = file.name;
      chat.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text,
        status: 'complete',
        attachments: [],
        artifacts: [],
      });
      records.push({ chat, files: [] });
    }
  }
  await storage.importRecords(records);
  state.chats.push(...records.map((r) => r.chat));
  await selectChat(records[0]?.chat);
  $('chat-count').textContent = state.chats.length;
  renderHistory();
}
function bindEvents() {
  $('new-chat').onclick = guard(createChat);
  $('rename').onclick = guard(async () => {
    const title = await confirm({
      title: 'Rename conversation',
      description: 'The name is saved in this browser.',
      input: state.current.title,
      accept: 'Save name',
    });
    if (title) {
      state.current.title = title;
      await persist();
      $('rename').textContent = title;
    }
  });
  $('settings-button').onclick = () => showSettings(true);
  $('mobile-summary').onclick = () => showSettings(true);
  $('close-settings').onclick = () => showSettings(false);
  $('drawer-backdrop').onclick = () => showSettings(false);
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && $('settings').classList.contains('open')) showSettings(false);
    if (event.key === 'Tab' && $('settings').classList.contains('open')) {
      const focusable = [
        ...$('settings').querySelectorAll('button,select,textarea,input,summary'),
      ].filter((node) => !node.disabled && node.offsetParent !== null);
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  document
    .querySelectorAll('[data-close]')
    .forEach((b) => (b.onclick = () => b.closest('dialog').close()));
  $('history-button').onclick = () => {
    renderHistory();
    openDialog('history-dialog');
  };
  $('search-chats').oninput = renderHistory;
  $('theme').onchange = guard(async () => {
    const theme = $('theme').value;
    document.documentElement.dataset.theme = theme;
    await storage.setPreference('theme', theme);
  });
  $('text-size').oninput = guard(async () => {
    const size = Number($('text-size').value);
    applyTextSize(size);
    await storage.setPreference('textSize', size);
  });
  const fields = {
    model: 'model',
    effort: 'reasoningEffort',
    verbosity: 'verbosity',
    format: 'format',
    developer: 'systemPrompt',
    'max-tokens': 'maxOutputTokens',
    context: 'contextStrategy',
    window: 'contextWindowSize',
    temperature: 'temperature',
  };
  for (const [id, setting] of Object.entries(fields))
    $(id).addEventListener(
      id === 'developer' ? 'input' : 'change',
      guard(async () => {
        state.current.settings = normalizeSettings({
          ...state.current.settings,
          [setting]: $(id).value,
        });
        await persist();
        if (id !== 'developer') renderSettings();
      }),
    );
  const toggleTools = () => {
    $('tools-panel').hidden = !$('tools-panel').hidden;
    $('tools-toggle').setAttribute('aria-expanded', String(!$('tools-panel').hidden));
    $('add-tools').setAttribute('aria-expanded', String(!$('tools-panel').hidden));
  };
  $('tools-toggle').onclick = toggleTools;
  $('add-tools').onclick = toggleTools;

  document.querySelectorAll('.tool-option input').forEach(
    (input) =>
      (input.onchange = guard(async () => {
        if (input.checked && input.value !== 'web_search') {
          if (
            !(await confirm({
              title: `Enable paid ${toolNames[input.value]}?`,
              description:
                'This tool will be available for subsequent requests and may incur additional charges. You can turn it off in Tools.',
              accept: 'Enable paid tool',
              cost: true,
            }))
          ) {
            input.checked = false;
            return;
          }
        }
        state.current.settings.tools = [
          ...document.querySelectorAll('.tool-option input:checked'),
        ].map((i) => i.value);
        await persist();
        renderTools();
      })),
  );
  $('add-block').onclick = guard(async () => {
    state.current.settings.promptBlocks.push({ id: crypto.randomUUID(), text: '' });
    await persist();
    renderBlocks();
  });
  $('cleanup').onclick = guard(async () => {
    if (
      await confirm({
        title: 'Clean up remote files',
        description:
          'This deletes this conversation’s uploads from OpenAI. Local copies are kept and will be uploaded again when needed.',
        accept: 'Clean up',
      })
    ) {
      await cleanupRemote(state.current);
      errorNotice('Remote files cleaned up. Local copies are still available.');
    }
  });
  $('backup-button').onclick = () => openDialog('backup-dialog');
  $('export-current').onclick = guard(() => exportJSON(false));
  $('export-all').onclick = guard(() => exportJSON(true));
  $('export-docx').onclick = guard(async () => {
    const response = await fetch('/api/exports/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: plainExport(state.current) }),
    });
    if (!response.ok) throw new Error('Could not create the Word document.');
    download(await response.blob(), `${state.current.title}.docx`);
  });
  for (const ext of ['md', 'txt'])
    $(`export-${ext}`).onclick = () =>
      download(
        new Blob([plainExport(state.current)], { type: 'text/plain' }),
        `${state.current.title}.${ext}`,
      );
  $('import').onclick = () => $('import-input').click();
  $('import-input').onchange = guard(async (event) => {
    await importFiles(event.target.files);
    event.target.value = '';
  });
  $('file-input').accept = EXTENSIONS.map((ext) => `.${ext}`).join(',');
  $('attach').onclick = () => $('file-input').click();
  $('file-input').onchange = guard(async (event) => {
    await addFiles(event.target.files);
    event.target.value = '';
  });
  $('message-input').oninput = guard(async () => {
    if (!state.editId) {
      state.current.draft = $('message-input').value;
      await persist();
    }
    $('message-input').style.height = 'auto';
    $('message-input').style.height = Math.min(180, $('message-input').scrollHeight) + 'px';
  });
  $('message-input').onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      guard(sendMessage)();
    }
  };
  $('composer').onsubmit = (event) => {
    event.preventDefault();
    guard(sendMessage)();
  };
  $('stop').onclick = () => state.controller?.abort();
  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      dragDepth++;
      if (!state.busy) $('drop-hint').hidden = false;
    }
  });
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) $('drop-hint').hidden = true;
  });
  document.addEventListener(
    'drop',
    guard(async (event) => {
      event.preventDefault();
      dragDepth = 0;
      $('drop-hint').hidden = true;
      if (event.dataTransfer.files.length) await addFiles(event.dataTransfer.files);
    }),
  );
  $('message-input').addEventListener(
    'paste',
    guard(async (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) {
        event.preventDefault();
        await addFiles(files);
      }
    }),
  );
  window.addEventListener('pagehide', () => {
    if (state.current && state.writable) storage.saveChat(state.current).catch(() => {});
  });
  window.addEventListener('beforeunload', (event) => {
    if (pendingWrites || saveFailed) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
// Hide snapshots before history navigation; restored pages must revalidate the session.
window.addEventListener('pagehide', () => {
  document.body.hidden = true;
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
let sessionVerified = false;
function applyTextSize(value) {
  const size = Math.min(140, Math.max(80, Number(value) || 100));
  document.documentElement.style.fontSize = size + '%';
  $('text-size').value = size;
  $('text-size-value').value = size + '%';
  $('text-size').setAttribute('aria-valuetext', size + '%');
}
async function boot() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (response.status === 401) {
    location.replace('/login');
    return;
  }
  if (!response.ok) throw new Error('Could not open the session. Check the server configuration.');
  const runtime = await response.json();
  sessionVerified = true;
  state.config = {
    ...state.config,
    ...runtime,
    defaultSettings: normalizeSettings(runtime.defaultSettings),
  };
  await storage.openDatabase();
  if (navigator.locks) {
    let resolveLock;
    const acquired = new Promise((resolve) => (resolveLock = resolve));
    navigator.locks.request('noxi-workspace-writer', { ifAvailable: true }, async (lock) => {
      state.writable = Boolean(lock);
      resolveLock();
      if (lock) await new Promise(() => {});
    });
    await acquired;
  } else state.writable = true;
  state.chats = await storage.listChats();
  for (const chat of state.chats) {
    chat.settings = normalizeSettings(chat.settings);
    let changed = false;
    for (const message of chat.messages)
      if (message.status === 'streaming' || message.status === 'preparing') {
        message.status = 'interrupted';
        changed = true;
      }
    if (changed && state.writable) await storage.saveChat(chat);
  }
  const theme = await storage.getPreference('theme');
  if (theme && ['dark', 'light'].includes(theme.value))
    document.documentElement.dataset.theme = theme.value;
  $('theme').value = document.documentElement.dataset.theme;
  applyTextSize((await storage.getPreference('textSize'))?.value);
  $('model').replaceChildren(
    ...[...new Set(state.config.models.map((m) => m.group))].map((group) => {
      const node = element('optgroup');
      node.label = group;
      for (const m of state.config.models.filter((m) => m.group === group)) {
        const option = element('option', '', m.name);
        option.value = m.id;
        node.append(option);
      }
      return node;
    }),
  );
  bindEvents();
  const active = (await storage.getPreference('activeChat'))?.value;
  if (state.chats.length)
    await selectChat(state.chats.find((c) => c.id === active) || state.chats[0]);
  else if (state.writable) await createChat();
  else {
    state.current = newChat();
    renderSettings();
    renderMessages();
  }
  $('save-state').textContent = 'Saved';
  $('chat-count').textContent = state.chats.length;
  setBusy(false);
  document.body.hidden = false;
  if (!state.writable) {
    document.querySelectorAll('button,input,textarea,select').forEach((c) => (c.disabled = true));
    errorNotice(
      'Noxi is already open in another tab. Close that tab and reload this one to avoid overwriting conversations.',
    );
    return;
  }
  if (!runtime.configured)
    errorNotice(
      'Set OPENAI_API_KEY on the server to start chatting. You can organize conversations and settings in the meantime.',
    );
  storage.requestPersistence();
}
boot().catch((error) => {
  if (!sessionVerified) {
    const message = document.createElement('p');
    message.textContent = 'Could not verify your session. ';
    const retry = document.createElement('a');
    retry.href = '/login';
    retry.textContent = 'Return to sign in';
    message.append(retry);
    document.body.replaceChildren(message);
    document.body.hidden = false;
    return;
  }
  document.body.hidden = false;
  state.writable = false;
  setBusy(false);
  errorNotice(error);
  $('save-state').textContent = 'Storage error';
});
