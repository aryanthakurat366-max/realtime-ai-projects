(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const W = 1600, H = 900, BG = '#0b0e1c';
  const PALETTE = ['#ffffff', '#ff2d3d', '#ff9f1c', '#ffd60a', '#2ee59d', '#00d4ff', '#2f6bff', '#b35bff'];

  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: fine */ } },
  };

  // ---------- state ----------
  let socket = null;
  let me = null;
  let tool = 'pen';
  let color = PALETTE[1];
  let size = 4;
  let seq = 0;
  let current = null; // stroke being drawn by me: { id, last:[x,y], pending:[] }
  const strokes = new Map(); // id -> { c, s, pts: [[x0,y0,x1,y1], ...] }  (insertion order = draw order)
  const cursors = new Map();

  // ---------- helpers ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function randomCode() {
    const a = new Uint8Array(5);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('') + '-' + Math.floor(100 + Math.random() * 900);
  }
  function seg(c, s, x0, y0, x1, y1) {
    ctx.strokeStyle = c;
    ctx.lineWidth = s;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  function redraw() {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    for (const st of strokes.values()) for (const p of st.pts) seg(st.c, st.s, p[0], p[1], p[2], p[3]);
  }
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) * W) / r.width), Math.round(((e.clientY - r.top) * H) / r.height)];
  }

  // ---------- lobby ----------
  const params = new URLSearchParams(location.search);
  $('#name').value = store.get('cb_name') || '';
  $('#room').value = params.get('room') || randomCode();
  $('#newRoom').onclick = () => ($('#room').value = randomCode());
  $('#joinBtn').onclick = join;
  $('#room').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('#name').addEventListener('keydown', (e) => e.key === 'Enter' && join());

  function join() {
    const room = $('#room').value.trim();
    const name = $('#name').value.trim() || 'Guest' + Math.floor(100 + Math.random() * 900);
    $('#err').textContent = '';
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(room)) {
      $('#err').textContent = 'Room code: 3-32 letters, numbers, - or _';
      return;
    }
    store.set('cb_name', name);
    connect(room, name);
  }

  function connect(room, name) {
    socket = io('/board');
    const status = $('#status');
    const enter = () =>
      socket.emit('join', { room, name }, (res) => {
        if (!res || res.error) {
          $('#err').textContent = (res && res.error) || 'Could not join';
          socket.disconnect();
          return;
        }
        me = res.me;
        strokes.clear();
        for (const s of res.strokes) strokes.set(s.id, { c: s.c, s: s.s, pts: s.pts });
        redraw();
        renderUsers(res.users);
        $('#lobby').classList.add('hidden');
        $('#app').classList.remove('hidden');
        $('#roomLabel').textContent = room;
        history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
        status.textContent = 'live';
        status.className = 'ok';
      });
    socket.on('connect', enter); // also re-joins automatically after a dropped connection
    socket.on('disconnect', () => {
      status.textContent = 'reconnecting...';
      status.className = '';
    });

    socket.on('users', renderUsers);
    socket.on('segs', (m) => {
      let st = strokes.get(m.id);
      if (!st) strokes.set(m.id, (st = { c: m.c, s: m.s, pts: [] }));
      for (const p of m.pts) {
        st.pts.push(p);
        seg(st.c, st.s, p[0], p[1], p[2], p[3]);
      }
    });
    socket.on('undo', ({ id }) => {
      strokes.delete(id);
      redraw();
    });
    socket.on('clear', ({ by }) => {
      strokes.clear();
      redraw();
      toast(`${by} cleared the board`);
    });
    socket.on('cursor', ({ id, x, y }) => moveCursor(id, x, y));
    socket.on('cursor-gone', ({ id }) => {
      const el = cursors.get(id);
      if (el) el.remove();
      cursors.delete(id);
    });

    $('#roomLabel').textContent = room;
  }

  let userList = [];
  function renderUsers(users) {
    userList = users;
    const box = $('#users');
    box.textContent = '';
    for (const u of users) {
      const el = document.createElement('span');
      el.className = 'user';
      const dot = document.createElement('i');
      dot.style.background = u.color;
      el.append(dot, document.createTextNode(u.name + (me && u.id === me.id ? ' (you)' : '')));
      box.append(el);
    }
  }

  function moveCursor(id, x, y) {
    let el = cursors.get(id);
    if (!el) {
      const u = userList.find((v) => v.id === id);
      el = document.createElement('div');
      el.className = 'cur';
      el.style.setProperty('--c', u ? u.color : '#fff');
      const b = document.createElement('b');
      b.textContent = u ? u.name : '';
      el.append(b);
      $('#cursors').append(el);
      cursors.set(id, el);
    }
    const box = $('#cursors').getBoundingClientRect();
    el.style.transform = `translate(${(x / W) * box.width}px, ${(y / H) * box.height}px)`;
  }

  // ---------- drawing ----------
  const penColor = () => (tool === 'eraser' ? BG : color);
  const penSize = () => (tool === 'eraser' ? size * 3 : size);

  function flush() {
    if (!current || !current.pending.length || !socket) return;
    socket.emit('segs', { id: current.id, c: current.c, s: current.s, pts: current.pending });
    current.pending = [];
  }
  setInterval(flush, 30); // batch ~30 ms of movement into a single WebSocket message

  canvas.addEventListener('pointerdown', (e) => {
    if (!me || e.button > 0) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);
    const id = `${me.id.slice(0, 8)}-${(++seq).toString(36)}${Date.now().toString(36)}`;
    current = { id, last: [x, y], pending: [[x, y, x, y]], c: penColor(), s: penSize() };
    strokes.set(id, { c: current.c, s: current.s, pts: [[x, y, x, y]] });
    seg(current.c, current.s, x, y, x, y);
  });

  let lastCursorSent = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (!me) return;
    const [x, y] = pos(e);
    const now = performance.now();
    if (socket && now - lastCursorSent > 40) {
      lastCursorSent = now;
      socket.volatile.emit('cursor', { x, y });
    }
    if (!current) return;
    const [px, py] = current.last;
    if (px === x && py === y) return;
    const p = [px, py, x, y];
    current.last = [x, y];
    current.pending.push(p);
    strokes.get(current.id).pts.push(p);
    seg(current.c, current.s, px, py, x, y);
  });

  const end = () => {
    flush();
    current = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  // ---------- toolbar ----------
  const sw = $('#swatches');
  PALETTE.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === color ? ' sel' : '');
    b.style.background = c;
    b.type = 'button';
    b.setAttribute('aria-label', 'Color ' + c);
    b.onclick = () => {
      color = c;
      setTool('pen');
      sw.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('sel', x === b));
    };
    sw.append(b);
  });
  function setTool(t) {
    tool = t;
    $('#toolPen').classList.toggle('active', t === 'pen');
    $('#toolEraser').classList.toggle('active', t === 'eraser');
  }
  $('#toolPen').onclick = () => setTool('pen');
  $('#toolEraser').onclick = () => setTool('eraser');
  $('#size').oninput = (e) => (size = +e.target.value);
  const undo = () => socket && socket.emit('undo');
  $('#undo').onclick = undo;
  $('#clear').onclick = () => confirm('Clear the board for everyone?') && socket.emit('clear');
  $('#save').onclick = () => {
    const a = document.createElement('a');
    a.download = 'collabboard.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  $('#copyLink').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent($('#roomLabel').textContent)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied');
    } catch {
      prompt('Copy this invite link:', url);
    }
  };
  $('#leave').onclick = () => {
    if (socket) socket.disconnect();
    location.href = location.pathname;
  };
  document.addEventListener('keydown', (e) => {
    if (!me || /input|textarea/i.test(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if (e.key === 'p') setTool('pen');
    else if (e.key === 'e') setTool('eraser');
  });

  redraw();
})();
