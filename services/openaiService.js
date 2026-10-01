// The UI receives a small stable event protocol, never raw provider objects.
export async function streamResponse(client, request, signal, send) {
  const stream = await client.responses.create(request, { signal });
  let finished = false;
  let fullText = '';
  const artifacts = new Set();
  for await (const event of stream) {
    if (signal.aborted) break;
    if (['response.output_text.delta', 'response.refusal.delta'].includes(event.type)) {
      fullText += event.delta || '';
      send({ type: 'delta', text: event.delta || '' });
    } else if (
      event.type === 'response.output_item.added' &&
      /_call$/.test(event.item?.type || '')
    ) {
      send({ type: 'tool', tool: event.item.type, status: 'running' });
    } else if (event.type === 'response.output_item.done') {
      await processOutput(client, event.item, signal, send, artifacts);
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      for (const item of event.response.output || [])
        await processOutput(client, item, signal, send, artifacts);
      send({
        type: 'done',
        status: event.type === 'response.completed' ? 'complete' : 'incomplete',
        text: fullText,
        usage: event.response.usage,
        responseId: event.response.id,
        reason: event.response.incomplete_details?.reason,
      });
      finished = true;
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error('Provider stream failed');
    }
  }
  if (!finished && !signal.aborted) throw new Error('Stream ended without completion');
}
async function processOutput(client, item, signal, send, seen) {
  if (!item) return;
  if (/_call$/.test(item.type))
    send({ type: 'tool', tool: item.type, status: item.status || 'completed' });
  if (item.type === 'image_generation_call' && item.result && !seen.has(item.id)) {
    seen.add(item.id);
    const format = item.output_format || 'png';
    send({
      type: 'artifact',
      name: `image-${item.id}.${format}`,
      mime: `image/${format === 'jpg' ? 'jpeg' : format}`,
      data: item.result,
    });
  }
  for (const content of item.content || []) {
    for (const annotation of content.annotations || []) {
      if (annotation.type === 'url_citation')
        send({ type: 'citation', url: annotation.url, title: annotation.title });
      if (annotation.type !== 'container_file_citation' || seen.has(annotation.file_id)) continue;
      seen.add(annotation.file_id);
      const descriptor = {
        name: annotation.filename || 'file',
        fileId: annotation.file_id,
        containerId: annotation.container_id,
      };
      try {
        const response = await client.containers.files.content.retrieve(
          annotation.file_id,
          { container_id: annotation.container_id },
          { signal },
        );
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 32 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('Output too large');
          }
          chunks.push(Buffer.from(value));
        }
        send({
          type: 'artifact',
          ...descriptor,
          mime: response.headers.get('content-type') || 'application/octet-stream',
          data: Buffer.concat(chunks).toString('base64'),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        send({
          type: 'artifact-unavailable',
          ...descriptor,
          error:
            'Could not save this file (local limit: 32 MiB). The remote container is temporary.',
        });
      }
    }
  }
}
