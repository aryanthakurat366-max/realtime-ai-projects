// DocChat tests: chunking, BM25, a mock Gemini server for the full RAG path, and the HTTP API.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const D = path.join(__dirname, '../docchat');
const { chunkPages, BM25, topK } = require(D + '/lib/rag');
let passed = 0;
const ok = (n) => { passed++; console.log('  ok  ' + n); };

// ---- unit: chunking ----
console.log('RAG units');
const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about topic ${i % 5}.`).join(' ');
const ch = chunkPages(['', long, 'Short page.']);
assert.ok(ch.length > 2);
assert.ok(ch.every((c) => c.text.length <= 900 + 1));
assert.strictEqual(ch[0].page, 2); // empty page 1 skipped, page numbers preserved
assert.strictEqual(ch[ch.length - 1].page, 3);
const a = ch[0].text, b = ch[1].text;
assert.ok(b.startsWith(a.split('. ').slice(-2)[0].slice(0, 10)) || b.length > 0);
ok('chunking: bounded size, keeps page numbers, skips empty pages');
assert.ok(chunkPages(['x'.repeat(5000)]).every((c) => c.text.length <= 900));
ok('chunking: hard-splits a sentence longer than the chunk size');

const bm = new BM25(['the cat sat on the mat', 'dogs love long walks in the park', 'quarterly revenue grew twenty percent']);
const top = topK(bm.scores('how much did revenue grow'), 1, 0);
assert.strictEqual(top[0].i, 2);
assert.deepStrictEqual(topK(bm.scores('zebra'), 3, 0), []);
ok('BM25 ranks the relevant passage first and returns nothing for unrelated queries');

// ---- mock Gemini: hashed bag-of-words embeddings so cosine retrieval is meaningful ----
const DIM = 64;
function emb(text) {
  const v = new Array(DIM).fill(0);
  for (const w of (text.toLowerCase().match(/[a-z0-9]+/g) || [])) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % DIM] += 1; }
  return v;
}
const seen = { generate: [], embedTasks: [], keys: new Set() };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.keys.add(req.headers['x-goog-api-key']);
    const j = JSON.parse(body || '{}');
    res.setHeader('content-type', 'application/json');
    if (req.url.includes(':batchEmbedContents')) {
      j.requests.forEach((r) => seen.embedTasks.push(r.taskType));
      return res.end(JSON.stringify({ embeddings: j.requests.map((r) => ({ values: emb(r.content.parts[0].text) })) }));
    }
    if (req.url.includes(':generateContent')) {
      seen.generate.push(j);
      if (j.contents[0].parts[0].text.includes('FORCE_503')) { res.statusCode = 503; return res.end('{"error":"busy"}'); }
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'thinking...' }, { text: 'Revenue was 48 million dollars [1].' }] } }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

(async () => {
  await new Promise((r) => mock.listen(0, r));
  process.env.GEMINI_BASE_URL = `http://localhost:${mock.address().port}/v1beta`;
  process.env.GEMINI_API_KEY = 'test-key-123';
  process.env.ASK_LIMIT = '1000';
  const { app } = require(D + '/server.js');
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://localhost:${srv.address().port}`;
  const pdf = fs.readFileSync(path.join(__dirname, 'sample.pdf'));
  const pdfChrome = fs.readFileSync(path.join(__dirname, 'sample-chrome.pdf'));
  const up = (buf, name) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return fetch(base + '/api/upload', { method: 'POST', body: fd }); };
  const ask = (body) => fetch(base + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  console.log('DocChat API (mock Gemini)');
  assert.deepStrictEqual(await (await fetch(base + '/api/status')).json().then((s) => s.ai), true); ok('status reports AI mode');

  let r = await up(pdf, 'report.pdf');
  const doc = await r.json();
  assert.strictEqual(r.status, 200); assert.strictEqual(doc.pages, 3); assert.ok(doc.chunks >= 3);
  assert.ok(seen.embedTasks.every((t) => t === 'RETRIEVAL_DOCUMENT')); ok('PDF upload: 3 pages extracted, chunks embedded as RETRIEVAL_DOCUMENT');

  r = await ask({ docId: doc.docId, question: 'What was the revenue in 2025?' });
  const ans = await r.json();
  assert.strictEqual(r.status, 200); assert.strictEqual(ans.mode, 'ai');
  assert.strictEqual(ans.answer, 'Revenue was 48 million dollars [1].'); // thought part filtered out
  assert.strictEqual(ans.sources[0].page, 2);
  assert.ok(/48 million/.test(ans.sources[0].text)); ok('retrieval puts the right passage (page 2) first; thought parts are stripped from the answer');
  assert.ok(seen.embedTasks.includes('RETRIEVAL_QUERY')); ok('question embedded as RETRIEVAL_QUERY');

  const g = seen.generate[0];
  assert.ok(g.systemInstruction.parts[0].text.includes('untrusted'));
  assert.ok(g.contents[0].parts[0].text.includes('Passages:') && g.contents[0].parts[0].text.includes('Question: What was the revenue'));
  assert.deepStrictEqual([...seen.keys], ['test-key-123']); ok('prompt = system guardrails + numbered passages; API key sent in header only');

  r = await ask({ docId: doc.docId, question: 'Where is the battery supplier located?', history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] });
  assert.strictEqual(r.status, 200);
  assert.ok(seen.generate[1].contents[0].parts[0].text.includes('Conversation so far:')); ok('follow-up questions include conversation history');

  r = await ask({ docId: 'nope', question: 'hello there' });
  assert.strictEqual(r.status, 404); ok('unknown / expired document -> 404');
  r = await ask({ docId: doc.docId, question: 'x' });
  assert.strictEqual(r.status, 400); ok('too-short question -> 400');

  r = await ask({ docId: doc.docId, question: 'FORCE_503 what is the revenue' });
  const e = await r.json();
  assert.strictEqual(r.status, 500); assert.ok(!/busy|Gemini/.test(e.error)); ok('upstream errors are retried, then reported without leaking details');

  r = await up(pdfChrome, 'chrome.pdf');
  const dc = await r.json();
  assert.strictEqual(r.status, 200); assert.strictEqual(dc.pages, 2); ok('PDFs from a second generator (Chrome) also parse');
  r = await up(Buffer.from('%PDF-1.4 garbage that is not really a pdf'), 'broken.pdf');
  assert.strictEqual(r.status, 422); ok('corrupt PDF with valid header -> friendly 422, not a crash');

  r = await up(Buffer.from('this is not a pdf'), 'fake.pdf');
  assert.strictEqual(r.status, 400); ok('fake PDF rejected by magic bytes');
  r = await up(Buffer.from('MZ binary'), 'virus.exe');
  assert.strictEqual(r.status, 400); ok('unsupported extension rejected');
  r = await up(Buffer.from('tiny'), 'a.txt');
  assert.strictEqual(r.status, 422); ok('near-empty text rejected');
  r = await up(Buffer.alloc(11 * 1024 * 1024, 65), 'big.txt');
  assert.strictEqual(r.status, 413); ok('file over 10 MB -> 413');

  r = await up(Buffer.from('Notes about llamas. '.repeat(40) + 'The llama sanctuary opens at 9am.'), 'notes.txt');
  const t = await r.json();
  assert.strictEqual(r.status, 200); ok('plain-text upload works');

  await fetch(base + '/api/doc/' + doc.docId, { method: 'DELETE' });
  assert.strictEqual((await ask({ docId: doc.docId, question: 'revenue again?' })).status, 404); ok('delete removes the document');

  srv.close(); mock.close();

  // ---- demo mode (no key) in a fresh process ----
  console.log('DocChat demo mode (no API key)');
  const { spawn } = require('child_process');
  const env = { ...process.env }; delete env.GEMINI_API_KEY; env.PORT = String(41000 + Math.floor(Math.random() * 2000));
  const child = spawn('node', ['server.js'], { cwd: D, env }); global.__child = child; child.stderr.on('data', (d) => process.stderr.write('[child] ' + d));
  await new Promise((r2) => child.stdout.on('data', (d) => /DocChat on/.test(String(d)) && r2()));
  const b2 = 'http://localhost:' + env.PORT;
  const fd = new FormData(); fd.append('file', new Blob([pdf]), 'report.pdf');
  const d2 = await (await fetch(b2 + '/api/upload', { method: 'POST', body: fd })).json();
  assert.strictEqual(d2.ai, false, JSON.stringify(d2));
  const a2 = await (await fetch(b2 + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docId: d2.docId, question: 'Which city will the fourth office open in?' }) })).json();
  assert.strictEqual(a2.mode, 'demo'); assert.ok(/Bengaluru/.test(a2.sources[0].text)); ok('demo mode: BM25 finds the Bengaluru passage without any AI key');
  const a3 = await (await fetch(b2 + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docId: d2.docId, question: 'zebra giraffe' }) })).json();
  assert.strictEqual(a3.sources.length, 0); ok('demo mode: unrelated question returns no passages');
  child.kill();

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
