import { getModel, normalizeSettings, selectContext } from '../public/core/models.js';
import { getRuntimeConfig } from './configService.js';

export function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function buildResponseRequest(body, verifyFile) {
  if (!body || !getModel(body.settings?.model)) throw httpError('Unsupported model.');
  const settings = normalizeSettings(body.settings);
  const model = getModel(settings.model);
  if (
    Array.isArray(body.settings.tools) &&
    body.settings.tools.some((tool) => !model.tools.includes(tool))
  )
    throw httpError('Tool is not supported by this model.');
  if (settings.tools.includes('web_search') && body.webSearchConfirmed !== true)
    throw httpError(
      'Web Search incurs charges. Confirm the cost of this request before continuing.',
      428,
    );
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1000)
    throw httpError('Invalid or oversized history. Use a context window.');
  if (body.messages.some((message) => !message || !['user', 'assistant'].includes(message.role)))
    throw httpError('Invalid message role.');
  const messages = selectContext(body.messages, settings);
  let totalFiles = 0;
  const input = messages.map((message) => {
    if (
      !['user', 'assistant'].includes(message.role) ||
      typeof message.text !== 'string' ||
      message.text.length > 500000
    )
      throw httpError('Invalid message.');
    if (message.role === 'assistant') return { role: 'assistant', content: message.text };
    const content = [];
    if (message.text.trim()) content.push({ type: 'input_text', text: message.text });
    const limit = getRuntimeConfig().maxAttachments;
    if (!Array.isArray(message.attachments) || message.attachments.length > limit)
      throw httpError(`Invalid attachments (maximum ${limit} per message).`);
    for (const attachment of message.attachments) {
      if (++totalFiles > 32) throw httpError('Too many files in context. Reduce the window.');
      const file = verifyFile(attachment?.receipt);
      if (file.image ? !model.vision : !model.files)
        throw httpError(
          file.image ? 'This model does not support images.' : 'This model does not support files.',
        );
      content.push(
        file.image
          ? { type: 'input_image', file_id: file.id, detail: 'auto' }
          : { type: 'input_file', file_id: file.id },
      );
    }
    if (!content.length) throw httpError('The message is empty.');
    return { role: 'user', content };
  });
  if (input.at(-1)?.role !== 'user') throw httpError('Context must end with a user message.');
  const instructions = [
    settings.systemPrompt || process.env.OPENAI_DEVELOPER_MESSAGE || '',
    ...settings.promptBlocks.map((block) => block.text),
    settings.format === 'json_object' ? 'Return valid JSON.' : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const request = {
    model: settings.model,
    input,
    instructions,
    stream: true,
    store: false,
    max_output_tokens: settings.maxOutputTokens,
    text: { format: { type: settings.format } },
  };
  if (model.reasoning.length) request.reasoning = { effort: settings.reasoningEffort };
  if (model.verbosity) request.text.verbosity = settings.verbosity;
  if (model.temperature) request.temperature = settings.temperature;
  if (settings.tools.length) {
    request.tools = settings.tools.map((type) =>
      type === 'code_interpreter'
        ? { type, container: { type: 'auto', memory_limit: '1g' } }
        : { type },
    );
    request.tool_choice = 'auto';
  }
  return request;
}
