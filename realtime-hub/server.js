/**
 * Realtime Hub
 *  - /board  namespace : CollabBoard, a shared whiteboard over WebSockets (Socket.IO)
 *  - /meet   namespace : MeetUp, a WebRTC mesh video call; this server is only the *signaling* channel
 *
 * Media never touches this server. It only relays SDP offers/answers and ICE candidates.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5, // 100 KB per message is plenty for strokes and SDP
  pingInterval: 20000,
  pingTimeout: 20000,
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // camera/microphone/screen only for our own origin
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

/** ICE servers. STUN is free; set TURN_URLS/TURN_USER/TURN_PASS for users behind strict NATs. */
app.get('/api/ice', (_req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((s) => s.trim()),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  res.json({ iceServers });
});

// ---------- helpers ----------
const ROOM_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const ID_RE = /^[\w-]{1,40}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const clean = (s, n = 24) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, n);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));

/** Tiny per-socket token bucket so one noisy client cannot flood a room. */
function limiter(ratePerSec, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * ratePerSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

// =====================================================================
// CollabBoard  (WebSockets)
// =====================================================================
const BOARD_W = 1600;
const BOARD_H = 900;
const MAX_STROKES = 3000;
const MAX_PTS_PER_STROKE = 20000;
const MAX_BOARD_USERS = 25;
const ROOM_TTL_MS = 15 * 60 * 1000; // keep an empty board for 15 min so refreshes don't lose work
const USER_COLORS = ['#ff2d3d', '#2f6bff', '#2ee59d', '#ffb02e', '#b35bff', '#00d4ff', '#ff6fb5', '#9be564'];

const boards = new Map(); // room -> { strokes: Map, users: Map, timer }
const board = io.of('/board');

function getBoard(room) {
  let b = boards.get(room);
  if (!b) {
    b = { strokes: new Map(), users: new Map(), timer: null };
    boards.set(room, b);
  }
  if (b.timer) {
    clearTimeout(b.timer);
    b.timer = null;
  }
  return b;
}

board.on('connection', (socket) => {
  let room = null;
  const allow = limiter(120, 240);

  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const r = payload && payload.room;
    if (!ROOM_RE.test(String(r))) return reply({ error: 'Room code must be 3-32 letters, numbers, - or _' });
    if (room) leave(); // re-join after a reconnect

    const b = getBoard(r);
    if (b.users.size >= MAX_BOARD_USERS) return reply({ error: 'This board is full' });

    const used = new Set([...b.users.values()].map((u) => u.color));
    const color = USER_COLORS.find((c) => !used.has(c)) || USER_COLORS[b.users.size % USER_COLORS.length];
    const user = { id: socket.id, name: clean(payload.name) || 'Guest', color };
    b.users.set(socket.id, user);
    room = r;
    socket.join(room);

    reply({
      me: user,
      users: [...b.users.values()],
      strokes: [...b.strokes.entries()].map(([id, s]) => ({ id, c: s.c, s: s.s, pts: s.pts })),
      size: { w: BOARD_W, h: BOARD_H },
    });
    socket.to(room).emit('users', [...b.users.values()]);
  });

  // a batch of line segments belonging to one stroke
  socket.on('segs', (m) => {
    if (!room || !allow() || !m || !ID_RE.test(String(m.id)) || !Array.isArray(m.pts)) return;
    const b = boards.get(room);
    if (!b) return;
    const id = String(m.id);
    const c = COLOR_RE.test(m.c) ? m.c : '#ffffff';
    const s = clamp(m.s, 1, 80);

    let stroke = b.strokes.get(id);
    if (stroke && stroke.owner !== socket.id) return; // cannot extend someone else's stroke
    if (!stroke) {
      stroke = { owner: socket.id, c, s, pts: [] };
      b.strokes.set(id, stroke);
      if (b.strokes.size > MAX_STROKES) b.strokes.delete(b.strokes.keys().next().value);
    }

    const pts = [];
    for (const p of m.pts.slice(0, 200)) {
      if (!Array.isArray(p) || p.length !== 4) continue;
      pts.push([
        Math.round(clamp(p[0], 0, BOARD_W)),
        Math.round(clamp(p[1], 0, BOARD_H)),
        Math.round(clamp(p[2], 0, BOARD_W)),
        Math.round(clamp(p[3], 0, BOARD_H)),
      ]);
    }
    if (!pts.length || stroke.pts.length + pts.length > MAX_PTS_PER_STROKE) return;
    stroke.pts.push(...pts);
    socket.to(room).emit('segs', { id, c: stroke.c, s: stroke.s, pts });
  });

  socket.on('cursor', (m) => {
    if (!room || !m) return;
    socket.volatile.to(room).emit('cursor', {
      id: socket.id,
      x: clamp(m.x, 0, BOARD_W),
      y: clamp(m.y, 0, BOARD_H),
    });
  });

  // undo removes *my* most recent stroke
  socket.on('undo', () => {
    if (!room) return;
    const b = boards.get(room);
    if (!b) return;
    const ids = [...b.strokes.keys()];
    for (let i = ids.length - 1; i >= 0; i--) {
      if (b.strokes.get(ids[i]).owner === socket.id) {
        b.strokes.delete(ids[i]);
        board.to(room).emit('undo', { id: ids[i] });
        break;
      }
    }
  });

  socket.on('clear', () => {
    if (!room || !allow()) return;
    const b = boards.get(room);
    if (!b) return;
    b.strokes.clear();
    board.to(room).emit('clear', { by: b.users.get(socket.id)?.name || 'Someone' });
  });

  function leave() {
    if (!room) return;
    const b = boards.get(room);
    const r = room;
    room = null;
    socket.leave(r);
    if (!b) return;
    b.users.delete(socket.id);
    board.to(r).emit('cursor-gone', { id: socket.id });
    board.to(r).emit('users', [...b.users.values()]);
    if (b.users.size === 0) {
      b.timer = setTimeout(() => boards.delete(r), ROOM_TTL_MS);
      b.timer.unref?.();
    }
  }
  socket.on('disconnect', leave);
});

// =====================================================================
// MeetUp  (WebRTC signaling)
// =====================================================================
const MAX_MEET_PEERS = 6; // full mesh: every peer sends N-1 video streams, so keep it small
const meetRooms = new Map(); // room -> Map(socketId -> { name })
const meet = io.of('/meet');

meet.on('connection', (socket) => {
  let room = null;
  const allow = limiter(60, 120);

  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const r = payload && payload.room;
    if (!ROOM_RE.test(String(r))) return reply({ error: 'Room code must be 3-32 letters, numbers, - or _' });
    if (room) return reply({ error: 'Already joined' });

    const peers = meetRooms.get(r) || new Map();
    if (peers.size >= MAX_MEET_PEERS) return reply({ error: `Room is full (max ${MAX_MEET_PEERS} people)` });

    const name = clean(payload.name) || 'Guest';
    const existing = [...peers.entries()].map(([id, p]) => ({ id, name: p.name }));
    peers.set(socket.id, { name });
    meetRooms.set(r, peers);
    room = r;
    socket.join(r);

    // tell the others first, then answer the newcomer, who will send the offers
    socket.to(r).emit('peer-joined', { id: socket.id, name });
    reply({ id: socket.id, peers: existing });
  });

  // relay SDP / ICE to one specific peer in the same room
  socket.on('signal', (m) => {
    if (!room || !allow() || !m || typeof m.to !== 'string' || typeof m.data !== 'object' || !m.data) return;
    const peers = meetRooms.get(room);
    if (!peers || !peers.has(m.to)) return;
    meet.to(m.to).emit('signal', { from: socket.id, data: m.data });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    const peers = meetRooms.get(room);
    if (!peers) return;
    peers.delete(socket.id);
    socket.to(room).emit('peer-left', { id: socket.id });
    if (peers.size === 0) meetRooms.delete(room);
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Realtime Hub listening on :${PORT}`));
}
module.exports = { server, io, app };
