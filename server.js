import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createApiRouter } from './routes/api.js';
import { requirePasskey } from './middleware/auth.js';
dotenv.config({ quiet: true });
const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  if (
    req.method !== 'GET' &&
    req.headers.origin &&
    new URL(req.headers.origin).host !== req.headers.host
  )
    return res.status(403).json({ error: 'Origin not allowed.' });
  next();
});
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));
app.use(requirePasskey);
app.use('/api', createApiRouter());
app.get('/login', (req, res) => res.sendFile(path.join(root, 'public', 'login.html')));
app.use(express.static(path.join(root, 'public'), { etag: true, maxAge: 0 }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 500;
  res.status(status >= 400 && status <= 599 ? status : 500).json({
    error:
      status === 413
        ? 'The file or context exceeds the upload limit.'
        : status < 500
          ? err.message
          : 'Could not complete the request. Check the server configuration.',
  });
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () =>
    console.log('Noxi: http://localhost:' + (process.env.PORT || 3000)),
  );
}
export default app;
