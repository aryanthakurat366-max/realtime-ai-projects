(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: fine */ } },
  };

  // ---------- state ----------
  let socket = null;
  let localStream = null; // camera + mic
  let camTrack = null;
  let screenStream = null;
  let myName = 'Guest';
  let micOn = true;
  let camOn = true;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let unread = 0;
  const peers = new Map(); // socketId -> { pc, dc, name, tile, stream, pendingIce, videoSender, mic, cam }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function randomCode() {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  }

  // ---------- lobby + local media ----------
  const params = new URLSearchParams(location.search);
  $('#name').value = store.get('mu_name') || '';
  $('#room').value = params.get('room') || randomCode();
  $('#newRoom').onclick = () => ($('#room').value = randomCode());

  async function getMedia() {
    // Degrade gracefully: camera+mic -> mic only -> camera only -> nothing (you can still watch and chat)
    for (const c of [{ video: true, audio: true }, { audio: true }, { video: true }]) {
      try {
        return await navigator.mediaDevices.getUserMedia(c);
      } catch { /* try next */ }
    }
    return new MediaStream();
  }

  (async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#err').textContent = 'This browser cannot access the camera (HTTPS is required).';
      localStream = new MediaStream();
    } else {
      localStream = await getMedia();
    }
    camTrack = localStream.getVideoTracks()[0] || null;
    $('#preview').srcObject = localStream;
    if (!localStream.getAudioTracks().length) $('#pvMic').disabled = true;
    if (!camTrack) $('#pvCam').disabled = true;
  })();

  function applyMic() {
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    $('#pvMic').textContent = micOn ? '🎙️ Mic on' : '🔇 Mic off';
    $('#mic').classList.toggle('off', !micOn);
    $('#mic').textContent = micOn ? '🎙️' : '🔇';
  }
  function applyCam() {
    if (camTrack) camTrack.enabled = camOn;
    $('#pvCam').textContent = camOn ? '📷 Camera on' : '🚫 Camera off';
    $('#cam').classList.toggle('off', !camOn);
    const me = $('#tile-me');
    if (me) me.classList.toggle('cam-off', !camOn || !camTrack);
  }
  $('#pvMic').onclick = () => { micOn = !micOn; applyMic(); };
  $('#pvCam').onclick = () => { camOn = !camOn; applyCam(); };

  $('#joinBtn').onclick = join;
  $('#name').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('#room').addEventListener('keydown', (e) => e.key === 'Enter' && join());

  async function join() {
    const room = $('#room').value.trim();
    myName = $('#name').value.trim() || 'Guest' + Math.floor(100 + Math.random() * 900);
    $('#err').textContent = '';
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(room)) {
      $('#err').textContent = 'Room code: 3-32 letters, numbers, - or _';
      return;
    }
    store.set('mu_name', myName);
    $('#joinBtn').disabled = true;
    try {
      const r = await fetch('/api/ice');
      if (r.ok) iceServers = (await r.json()).iceServers;
    } catch { /* keep default STUN */ }

    socket = io('/meet');
    socket.once('connect', () => {
      socket.emit('join', { room, name: myName }, (res) => {
        if (!res || res.error) {
          $('#err').textContent = (res && res.error) || 'Could not join';
          $('#joinBtn').disabled = false;
          socket.disconnect();
          return;
        }
        enterCall(room, res);
      });
    });
    socket.on('connect_error', () => {
      $('#err').textContent = 'Cannot reach the server (it may be waking up). Try again in a few seconds.';
      $('#joinBtn').disabled = false;
    });
    socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') toast('Connection to server lost. Calls already running continue.');
    });
  }

  function enterCall(room, res) {
    $('#lobby').classList.add('hidden');
    $('#call').classList.remove('hidden');
    $('#roomLabel').textContent = room;
    history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);

    addLocalTile();
    applyMic();
    applyCam();
    if (!camTrack) $('#share').disabled = true;
    updateCount();

    // I am the newcomer: I create the offers to everyone already in the room.
    for (const p of res.peers) {
      createPeer(p.id, p.name);
      makeOffer(p.id);
    }

    socket.on('peer-joined', ({ id, name }) => {
      createPeer(id, name); // they will send me an offer
      sys(`${name} joined`);
    });
    socket.on('peer-left', ({ id }) => {
      const p = peers.get(id);
      if (p) sys(`${p.name} left`);
      removePeer(id);
    });
    socket.on('signal', onSignal);
  }

  // ---------- tiles ----------
  function makeTile(id, name, isMe) {
    const tile = document.createElement('div');
    tile.className = 'tile' + (isMe ? ' me' : '');
    if (isMe) tile.id = 'tile-me';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isMe) { video.muted = true; video.classList.add('mirror'); }
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const b = document.createElement('b');
    b.textContent = (name[0] || '?').toUpperCase();
    avatar.append(b);
    const label = document.createElement('div');
    label.className = 'label';
    const nm = document.createElement('span');
    nm.textContent = isMe ? `${name} (you)` : name;
    const mic = document.createElement('span');
    mic.className = 'micicon';
    label.append(nm, mic);
    tile.append(video, avatar, label);
    if (!isMe) {
      const conn = document.createElement('div');
      conn.className = 'conn';
      conn.textContent = 'connecting...';
      tile.append(conn);
    }
    $('#grid').append(tile);
    return { tile, video, mic, conn: tile.querySelector('.conn') };
  }
  function addLocalTile() {
    const t = makeTile('me', myName, true);
    t.video.srcObject = localStream;
  }
  function updateCount() {
    const n = peers.size + 1;
    $('#grid').dataset.n = n;
    $('#count').textContent = `${n} in call`;
  }

  // ---------- WebRTC ----------
  function createPeer(id, name) {
    const pc = new RTCPeerConnection({ iceServers });
    const t = makeTile(id, name, false);
    const peer = { pc, dc: null, name, tile: t, stream: new MediaStream(), pendingIce: [], videoSender: null, mic: true, cam: true };
    peers.set(id, peer);
    t.video.srcObject = peer.stream;

    // send what I have; for anything I lack, still ask to *receive* it
    const have = new Set();
    for (const track of localStream.getTracks()) {
      const sender = pc.addTrack(track, localStream);
      if (track.kind === 'video') peer.videoSender = sender;
      have.add(track.kind);
    }
    for (const kind of ['audio', 'video']) if (!have.has(kind)) pc.addTransceiver(kind, { direction: 'recvonly' });

    pc.onicecandidate = (e) => e.candidate && socket.emit('signal', { to: id, data: { candidate: e.candidate } });
    pc.ontrack = (e) => {
      peer.stream.addTrack(e.track);
      t.video.play().catch(() => {});
    };
    pc.ondatachannel = (e) => setupChannel(peer, e.channel);
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (!t.conn) return;
      t.conn.textContent = s === 'connected' ? 'connected' : s === 'failed' ? 'connection failed' : s;
      t.conn.classList.toggle('ok', s === 'connected');
      if (s === 'connected') setTimeout(() => (t.conn.style.display = 'none'), 1500);
      else t.conn.style.display = '';
    };
    updateCount();
    return peer;
  }

  async function makeOffer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    setupChannel(peer, peer.pc.createDataChannel('meet')); // the offerer creates the chat/state channel
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('signal', { to: id, data: { sdp: peer.pc.localDescription } });
  }

  async function onSignal({ from, data }) {
    try {
      let peer = peers.get(from);
      if (!peer) {
        if (!data.sdp) return;
        peer = createPeer(from, 'Guest');
      }
      const pc = peer.pc;
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        // candidates can outrun the offer; hold them until the remote description exists
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pendingIce.push(data.candidate);
      }
    } catch (err) {
      console.error('signal error', err);
    }
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch { /* already closed */ }
    p.tile.tile.remove();
    peers.delete(id);
    updateCount();
  }

  // ---------- data channel: chat + mic/cam state ----------
  function setupChannel(peer, dc) {
    peer.dc = dc;
    dc.onopen = () => dc.send(JSON.stringify({ t: 'state', mic: micOn && !!localStream.getAudioTracks().length, cam: camOn && !!camTrack }));
    dc.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'chat' && typeof m.text === 'string') addMsg(peer.name, m.text.slice(0, 500), false);
      if (m.t === 'state') {
        peer.mic = !!m.mic;
        peer.cam = !!m.cam;
        peer.tile.mic.textContent = peer.mic ? '' : '🔇';
        peer.tile.tile.classList.toggle('cam-off', !peer.cam);
      }
    };
  }
  function broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of peers.values()) if (p.dc && p.dc.readyState === 'open') p.dc.send(s);
  }
  function broadcastState() {
    broadcast({ t: 'state', mic: micOn && !!localStream.getAudioTracks().length, cam: camOn && !!camTrack });
  }

  // ---------- controls ----------
  $('#mic').onclick = () => { micOn = !micOn; applyMic(); broadcastState(); };
  $('#cam').onclick = () => { camOn = !camOn; applyCam(); broadcastState(); };

  $('#share').onclick = async () => {
    if (screenStream) return stopShare();
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch { return; } // user cancelled
    const track = screenStream.getVideoTracks()[0];
    track.onended = stopShare;
    // swap the outgoing video track in place: no renegotiation needed
    for (const p of peers.values()) if (p.videoSender) await p.videoSender.replaceTrack(track);
    const v = $('#tile-me video');
    v.srcObject = new MediaStream([track]);
    v.classList.remove('mirror');
    $('#share').classList.add('active');
    $('#tile-me').classList.remove('cam-off');
  };
  async function stopShare() {
    if (!screenStream) return;
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    for (const p of peers.values()) if (p.videoSender) await p.videoSender.replaceTrack(camTrack);
    const v = $('#tile-me video');
    v.srcObject = localStream;
    v.classList.add('mirror');
    $('#share').classList.remove('active');
    applyCam();
  }

  // chat
  const chat = $('#chat');
  $('#chatBtn').onclick = () => {
    chat.classList.toggle('hidden');
    if (!chat.classList.contains('hidden')) {
      unread = 0;
      $('#unread').classList.add('hidden');
      $('#chatIn').focus();
    }
  };
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chatIn').value.trim();
    if (!text) return;
    $('#chatIn').value = '';
    broadcast({ t: 'chat', text });
    addMsg(myName, text, true);
  };
  function addMsg(who, text, mine) {
    const el = document.createElement('div');
    el.className = 'msg' + (mine ? ' mine' : '');
    const s = document.createElement('small');
    s.textContent = mine ? 'You' : who;
    el.append(s, document.createTextNode(text)); // text node: never parsed as HTML
    $('#msgs').append(el);
    $('#msgs').scrollTop = $('#msgs').scrollHeight;
    if (!mine && chat.classList.contains('hidden')) {
      unread++;
      $('#unread').textContent = unread;
      $('#unread').classList.remove('hidden');
    }
  }
  function sys(text) {
    const el = document.createElement('div');
    el.className = 'msg sys';
    el.textContent = text;
    $('#msgs').append(el);
  }

  $('#copyLink').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent($('#roomLabel').textContent)}`;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    catch { prompt('Copy this invite link:', url); }
  };
  $('#leave').onclick = () => {
    for (const id of [...peers.keys()]) removePeer(id);
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    localStream.getTracks().forEach((t) => t.stop());
    if (socket) socket.disconnect();
    location.href = location.pathname;
  };
  window.addEventListener('beforeunload', () => socket && socket.disconnect());
})();
