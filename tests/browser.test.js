// End-to-end browser test: real WebRTC between two Chromium pages (fake camera) + live drawing sync.
const path = require('path');
const assert = require('assert');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { server } = require(path.join(__dirname, '../realtime-hub/server.js'));

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox'],
  });
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  const errors = [];
  const mk = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };

  // ---------- WebRTC ----------
  const a = await mk(), b = await mk();
  await a.goto(`${base}/meetup/?room=e2e-call`); await a.fill('#name', 'Alice'); await a.waitForTimeout(800); await a.click('#joinBtn');
  await a.waitForSelector('#call:not(.hidden)');
  await b.goto(`${base}/meetup/?room=e2e-call`); await b.fill('#name', 'Bob'); await b.waitForTimeout(800); await b.click('#joinBtn');
  await b.waitForSelector('#call:not(.hidden)');

  const remoteVideoPlaying = (p) => p.waitForFunction(() => {
    const v = [...document.querySelectorAll('.tile:not(.me) video')][0];
    return v && v.videoWidth > 0 && v.readyState >= 2;
  }, null, { timeout: 15000 });
  await remoteVideoPlaying(a); await remoteVideoPlaying(b);
  console.log('  ok  both browsers receive the other side\'s live video over WebRTC');

  assert.strictEqual(await a.locator('.tile').count(), 2);
  await a.click('#chatBtn'); await b.click('#chatBtn');
  await a.fill('#chatIn', 'hello <img src=x onerror=alert(1)> from Alice'); await a.press('#chatIn', 'Enter');
  await b.waitForFunction(() => document.querySelector('#msgs').textContent.includes('hello <img src=x'));
  assert.strictEqual(await b.locator('#msgs img').count(), 0);
  console.log('  ok  chat over RTCDataChannel works and HTML is not injected');

  await a.click('#mic'); // mute
  await b.waitForFunction(() => document.querySelector('.tile:not(.me) .micicon').textContent.includes('🔇'));
  await a.click('#cam');
  await b.waitForFunction(() => document.querySelector('.tile:not(.me)').classList.contains('cam-off'));
  console.log('  ok  mic/camera state is shown on the remote tile');

  await b.close();
  await a.waitForFunction(() => document.querySelectorAll('.tile').length === 1);
  console.log('  ok  tile removed when a peer leaves');

  // ---------- CollabBoard ----------
  const c = await mk(), d = await mk();
  for (const [p, n] of [[c, 'Cara'], [d, 'Dev']]) {
    await p.goto(`${base}/collabboard/?room=e2e-board`); await p.fill('#name', n); await p.click('#joinBtn');
    await p.waitForSelector('#app:not(.hidden)');
  }
  const box = await c.locator('canvas').boundingBox();
  await c.mouse.move(box.x + 200, box.y + 200); await c.mouse.down();
  for (let i = 0; i < 20; i++) await c.mouse.move(box.x + 200 + i * 15, box.y + 200 + Math.sin(i / 2) * 60);
  await c.mouse.up();
  const painted = (p) => p.evaluate(() => {
    const cv = document.querySelector('canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90) n++; return n; // red pen pixels
  });
  await d.waitForFunction(() => { const cv = document.querySelector('canvas'); const x = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 0; i < x.length; i += 4) if (x[i] > 200 && x[i + 1] < 90) return true; return false; }, null, { timeout: 5000 });
  assert.ok((await painted(d)) > 500);
  console.log('  ok  stroke drawn in one browser appears in the other');

  await d.mouse.move(box.x + 400, box.y + 300);
  await c.waitForSelector('.cur', { timeout: 5000 });
  console.log('  ok  live remote cursor shown');

  await c.click('#undo');
  await d.waitForFunction(() => { const cv = document.querySelector('canvas'); const x = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 0; i < x.length; i += 4) if (x[i] > 200 && x[i + 1] < 90) return false; return true; }, null, { timeout: 5000 });
  console.log('  ok  undo propagates');

  await c.screenshot({ path: process.env.SHOT_DIR + '/board.png' });
  assert.deepStrictEqual(errors, []);
  console.log('\nbrowser tests passed, no page errors');
  await browser.close(); process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
