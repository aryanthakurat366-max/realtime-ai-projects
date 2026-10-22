/**
 * DocChat: upload a PDF (or .txt/.md) and ask questions about it.
 *
 *   upload -> extract text per page -> chunk -> embed each chunk (Gemini)  [indexing]
 *   ask    -> embed question -> cosine top-k -> prompt with passages -> answer with [n] citations
 *
 * Without GEMINI_API_KEY the app still runs in "demo mode": BM25 keyword retrieval, no generated answer.
 * The API key lives only in the server environment and is never sent to the browser.
 */
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const pdfParse = require('pdf-parse');
const { chunkPages, BM25, dot, topK, Gemini, SYSTEM_PROMPT, buildPrompt } = require('./lib/rag');

const PORT = process.env.PORT || 3001;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_CHUNKS = 400;
const TTL_MS = 60 * 60 * 1000;
const MAX_DOCS = 30;
const TOP_K = 5;

const gemini = process.env.GEMINI_API_KEY
  ? new Gemini({
      apiKey: process.env.GEMINI_API_KEY,
      base: process.env.GEMINI_BASE_URL,
      embedModel: process.env.GEMINI_EMBED_MODEL,
      genModel: process.env.GEMINI_MODEL,
    })
  : null;

const app = express();
app.set('trust proxy', 1); // Render/Railway sit behind a proxy; needed for per-IP rate limits
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const docs = new Map(); // docId -> { name, pages, chunks, bm25, vectors, created }
setInterval(() => {
  const now = Date.now();
  for (const [id, d] of docs) if (now - d.created > TTL_MS) docs.delete(id);
}, 5 * 60 * 1000).unref();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});
const uploadLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.UPLOAD_LIMIT || 10), standardHeaders: true, legacyHeaders: false, message: { error: 'Too many uploads. Please try again later.' } });
const askLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.ASK_LIMIT || 60), standardHeaders: true, legacyHeaders: false, message: { error: 'Question limit reached for this hour. Please try again later.' } });

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', (_req, res) => res.json({ ai: !!gemini, maxMb: MAX_FILE_BYTES / 1024 / 1024, maxPages: MAX_PAGES }));

async function extractPages(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf')) {
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'That file is not a valid PDF.');
    const parse = (buf) => {
      const pages = [];
      return pdfParse(buf, {
        max: MAX_PAGES,
        pagerender: (page) =>
          page.getTextContent().then((tc) => {
            const text = tc.items.map((i) => i.str).join(' ');
            pages[page.pageIndex] = text;
            return text;
          }),
      }).then((data) => ({ data, pages }));
    };
    let result;
    try {
      result = await parse(file.buffer);
    } catch (first) {
      // pdf.js (bundled in pdf-parse) sometimes fails the first time on PDFs with a slightly off
      // cross-reference table and succeeds on a second attempt, so retry once before giving up.
      try {
        result = await parse(Buffer.from(file.buffer));
      } catch {
        throw httpError(422, 'This PDF could not be read. It may be corrupted or password-protected.');
      }
    }
    const { data, pages } = result;
    if (data.numpages > MAX_PAGES) throw httpError(413, `Too long. Max ${MAX_PAGES} pages.`);
    return pages.map((p) => p || '');
  }
  if (name.endsWith('.txt') || name.endsWith('.md')) {
    const text = file.buffer.toString('utf8');
    // treat every ~3000 chars as a "page" so citations still point somewhere useful
    const pages = [];
    for (let i = 0; i < text.length; i += 3000) pages.push(text.slice(i, i + 3000));
    return pages;
  }
  throw httpError(400, 'Please upload a PDF, .txt or .md file.');
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true; // safe to show to the user (unlike upstream API errors)
  return e;
}

app.post('/api/upload', uploadLimit, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw httpError(400, 'No file received.');
    const pages = await extractPages(req.file);
    const totalChars = pages.reduce((n, p) => n + p.trim().length, 0);
    if (totalChars < 50) throw httpError(422, 'No selectable text found. Scanned PDFs need OCR first.');

    const chunks = chunkPages(pages);
    if (chunks.length > MAX_CHUNKS) throw httpError(413, `Document is too large for the demo (${chunks.length} passages, max ${MAX_CHUNKS}).`);

    const entry = { name: req.file.originalname.slice(0, 120), pages: pages.length, chunks, bm25: new BM25(chunks.map((c) => c.text)), vectors: null, created: Date.now() };
    if (gemini) entry.vectors = await gemini.embed(chunks.map((c) => c.text), 'RETRIEVAL_DOCUMENT');

    if (docs.size >= MAX_DOCS) docs.delete(docs.keys().next().value);
    const docId = crypto.randomBytes(12).toString('hex'); // unguessable: knowing it is the access right
    docs.set(docId, entry);
    res.json({ docId, name: entry.name, pages: entry.pages, chunks: chunks.length, ai: !!gemini });
  } catch (e) {
    next(e);
  }
});

app.post('/api/ask', askLimit, async (req, res, next) => {
  try {
    const { docId, question, history } = req.body || {};
    const doc = docs.get(String(docId));
    if (!doc) throw httpError(404, 'This document session expired. Please upload it again.');
    const q = String(question || '').trim().slice(0, 500);
    if (q.length < 2) throw httpError(400, 'Ask a question first.');

    // 1) retrieve
    let hits;
    if (gemini) {
      const [qv] = await gemini.embed([q], 'RETRIEVAL_QUERY');
      hits = topK(doc.vectors.map((v) => dot(qv, v)), TOP_K);
    } else {
      hits = topK(doc.bm25.scores(q), TOP_K, 0);
    }
    const passages = hits.map((h) => ({ page: doc.chunks[h.i].page, text: doc.chunks[h.i].text, score: Number(h.score.toFixed(4)) }));
    const sources = passages.map((p, n) => ({ n: n + 1, ...p }));

    if (!passages.length) return res.json({ answer: 'I could not find anything related to that in the document.', sources: [], mode: gemini ? 'ai' : 'demo' });

    // 2) generate (or show passages in demo mode)
    if (!gemini) {
      return res.json({
        answer: 'Demo mode (no AI key configured on the server): here are the most relevant passages, ranked by keyword match.',
        sources,
        mode: 'demo',
      });
    }
    const hist = (Array.isArray(history) ? history : [])
      .slice(-6)
      .map((h) => ({ role: h && h.role === 'assistant' ? 'assistant' : 'user', text: String((h && h.text) || '').slice(0, 800) }));
    const answer = await gemini.generate({ system: SYSTEM_PROMPT, user: buildPrompt({ passages, history: hist, question: q }) });
    res.json({ answer, sources, mode: 'ai' });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/doc/:id', (req, res) => {
  docs.delete(req.params.id);
  res.json({ ok: true });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).` });
  if (err.expose) return res.status(err.status).json({ error: err.message });
  console.error(err);
  // never leak upstream error bodies (they can contain request details) to the browser
  if (err.status === 429) return res.status(503).json({ error: 'The AI service is busy right now. Please try again in a minute.' });
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) app.listen(PORT, () => console.log(`DocChat on :${PORT} (${gemini ? 'AI mode' : 'demo mode: set GEMINI_API_KEY'})`));
module.exports = { app, docs };
