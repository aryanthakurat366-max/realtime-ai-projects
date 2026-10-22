// Protocol tests for the Realtime Hub. Run: cd realtime-hub && npm test
const assert = require('assert');
const path = require('path');
const { io } = require(path.join(__dirname, '../realtime-hub/node_modules/socket.io-client'));
const { server } = require(path.join(__dirname, '../realtime-hub/server.js'));

const once = (s, ev, ms = 2000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
    s.once(ev, (v) => { clearTimeout(t); res(v); });
  });
const ack = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));
const connect = (base, ns) => new Promise((res) => { const s = io(base + ns, { forceNew: true }); s.on('connect', () => res(s)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  let passed = 0;
  const ok = (name) => { passed++; console.log('  ok  ' + name); };

  // ---------------- CollabBoard ----------------
  console.log('CollabBoard');
  const a = await connect(base, '/board');
  const b = await connect(base, '/board');

  assert.ok((await ack(a, 'join', { room: 'x', name: 'A' })).error); ok('rejects invalid room code');

  const ja = await ack(a, 'join', { room: 'room-1', name: '<b>Alice</b>' });
  assert.ok(ja.me && ja.me.id === a.id);
  assert.ok(!/[<>]/.test(ja.me.name)); ok('join works and sanitises name');

  const usersSeen = once(a, 'users');
  const jb = await ack(b, 'join', { room: 'room-1', name: 'Bob' });
  assert.strictEqual((await usersSeen).length, 2);
  assert.notStrictEqual(jb.me.color, ja.me.color); ok('second user joins, gets a different color');

  const got = once(b, 'segs');
  a.emit('segs', { id: 'a-1', c: '#ff2d3d', s: 4, pts: [[10, 10, 20, 20], [20, 20, 30, 35]] });
  const m = await got;
  assert.strictEqual(m.pts.length, 2); assert.strictEqual(m.id, 'a-1'); ok('strokes broadcast to other users');

  const c = await connect(base, '/board');
  const jc = await ack(c, 'join', { room: 'room-1', name: 'Carol' });
  assert.strictEqual(jc.strokes.length, 1); assert.strictEqual(jc.strokes[0].pts.length, 2); ok('late joiner receives existing strokes');

  b.emit('segs', { id: 'a-1', c: '#ffffff', s: 4, pts: [[0, 0, 5, 5]] }); // hijack attempt
  await sleep(150);
  const jd = await ack(c, 'join', { room: 'room-1', name: 'Carol' });
  assert.strictEqual(jd.strokes[0].pts.length, 2); ok("cannot extend another user's stroke");

  a.emit('segs', { id: 'bad id!', c: 'red', s: 9999, pts: [[1, 1, 2, 2]] });
  a.emit('segs', { id: 'a-2', c: 'not-a-color', s: 9999, pts: [[-50, 99999, 'x', 3], [1, 2, 3, 4]] });
  await sleep(150);
  const je = await ack(c, 'join', { room: 'room-1', name: 'Carol' });
  const s2 = je.strokes.find((s) => s.id === 'a-2');
  assert.ok(!je.strokes.find((s) => s.id === 'bad id!'));
  assert.strictEqual(s2.c, '#ffffff'); assert.strictEqual(s2.s, 80); assert.deepStrictEqual(s2.pts[0], [0, 900, 0, 3]); ok('invalid input is rejected or clamped');

  const und = once(b, 'undo');
  a.emit('undo');
  assert.strictEqual((await und).id, 'a-2'); ok('undo removes only the sender\'s latest stroke');

  const cl = once(b, 'clear');
  b.emit('clear');
  await cl; ok('clear broadcast');

  const gone = once(a, 'cursor-gone');
  c.disconnect();
  await gone; ok('disconnect notifies room');

  // ---------------- MeetUp signaling ----------------
  console.log('MeetUp signaling');
  const p1 = await connect(base, '/meet');
  const p2 = await connect(base, '/meet');
  const r1 = await ack(p1, 'join', { room: 'call-1', name: 'One' });
  assert.deepStrictEqual(r1.peers, []); ok('first peer sees an empty room');

  const joined = once(p1, 'peer-joined');
  const r2 = await ack(p2, 'join', { room: 'call-1', name: 'Two' });
  assert.strictEqual(r2.peers.length, 1); assert.strictEqual(r2.peers[0].id, p1.id);
  assert.strictEqual((await joined).id, p2.id); ok('newcomer gets existing peers, others get peer-joined');

  const sig = once(p1, 'signal');
  p2.emit('signal', { to: p1.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  const s = await sig;
  assert.strictEqual(s.from, p2.id); assert.strictEqual(s.data.sdp.type, 'offer'); ok('SDP relayed to the target peer with sender id');

  const outsider = await connect(base, '/meet');
  await ack(outsider, 'join', { room: 'other-room', name: 'X' });
  let leaked = false;
  p1.on('signal', () => (leaked = true));
  outsider.emit('signal', { to: p1.id, data: { candidate: {} } });
  await sleep(150);
  assert.ok(!leaked); ok('cannot signal a peer in a different room');

  const left = once(p1, 'peer-left');
  const p2id = p2.id; // socket.id is cleared on disconnect
  p2.disconnect();
  assert.strictEqual((await left).id, p2id); ok('peer-left on disconnect');

  const extra = [];
  for (let i = 0; i < 5; i++) { const x = await connect(base, '/meet'); extra.push(x); assert.ok(!(await ack(x, 'join', { room: 'call-1', name: 'n' + i })).error); }
  const over = await connect(base, '/meet');
  assert.ok((await ack(over, 'join', { room: 'call-1', name: 'late' })).error); ok('room capped at 6');

  const ice = await (await fetch(base + '/api/ice')).json();
  assert.ok(ice.iceServers.length >= 1); ok('/api/ice returns ICE servers');

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
