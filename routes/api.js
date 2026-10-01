import express from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';
import { Document, Paragraph, Packer, TextRun } from 'docx';
import { EXTENSIONS } from '../public/core/files.js';
import { buildResponseRequest, httpError } from '../services/requestService.js';
import { inspectUpload, signFile, verifyFile } from '../services/fileService.js';
import { streamResponse } from '../services/openaiService.js';
import { getRuntimeConfig } from '../services/configService.js';
function client() {
  if (!process.env.OPENAI_API_KEY) throw httpError('OPENAI_API_KEY is missing on the server.', 503);
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
}
export function createApiRouter() {
  const router = express.Router();
  router.get('/config', (req, res) =>
    res.json({
      ...getRuntimeConfig(),
      configured: Boolean(process.env.OPENAI_API_KEY),
      extensions: EXTENSIONS,
    }),
  );
  router.post('/exports/docx', async (req, res) => {
    if (typeof req.body.text !== 'string' || req.body.text.length > 500000)
      throw httpError('Invalid export text (maximum 500,000 characters).');
    const document = new Document({
      sections: [
        {
          children: req.body.text
            .split('\n')
            .map((line) => new Paragraph({ children: [new TextRun(line)] })),
        },
      ],
    });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="conversation.docx"');
    res.send(await Packer.toBuffer(document));
  });
  router.post(
    '/files',
    (req, res, next) =>
      multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: getRuntimeConfig().maxFileBytes, files: 1, fields: 0 },
      }).single('file')(req, res, next),
    async (req, res) => {
      const metadata = inspectUpload(req.file);
      const api = client();
      const result = await api.files.create({
        file: await toFile(req.file.buffer, metadata.name, { type: metadata.type }),
        purpose: metadata.image ? 'vision' : 'user_data',
        expires_after: { anchor: 'created_at', seconds: 86400 },
      });
      const expiresAt = Date.now() + 23 * 60 * 60 * 1000;
      res.json({
        receipt: signFile({ id: result.id, image: metadata.image, expiresAt }),
        expiresAt,
      });
    },
  );
  router.post('/files/cleanup', async (req, res) => {
    if (!Array.isArray(req.body.receipts) || req.body.receipts.length > 100)
      throw httpError('Invalid references.');
    const ids = [...new Set(req.body.receipts.map((receipt) => verifyFile(receipt).id))];
    const api = client();
    for (const id of ids) {
      try {
        await api.files.delete(id);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    res.json({ deleted: ids.length });
  });
  router.post('/responses', async (req, res) => {
    const request = buildResponseRequest(req.body, verifyFile);
    const api = client();
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event) => {
      if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
    };
    const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
    try {
      await streamResponse(api, request, controller.signal, send);
    } catch (err) {
      if (!controller.signal.aborted) send({ type: 'error', error: apiError(err) });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });
  return router;
}
function apiError(err) {
  if (err.status === 401) return 'The server API key is invalid.';
  if (err.status === 429)
    return 'OpenAI rate-limited the request or no balance is available. Check your account.';
  if (err.status === 400 || err.status === 404)
    return 'OpenAI rejected the model, parameters or a file. Check model access and attach your files again.';
  return 'The response was interrupted. Received text has been saved; you can retry.';
}
