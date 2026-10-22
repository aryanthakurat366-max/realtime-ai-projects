(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  let docId = null;
  let history = []; // [{role:'user'|'assistant', text}]
  let asking = false;

  fetch('/api/status').then((r) => r.json()).then((s) => {
    const m = $('#mode');
    m.textContent = s.ai ? 'AI mode: Gemini + RAG' : 'Demo mode: keyword search';
    m.className = 'badge ' + (s.ai ? 'ai' : 'demo');
  }).catch(() => { $('#mode').textContent = 'offline'; });

  // ---------- upload ----------
  const drop = $('#drop'), fileIn = $('#file');
  drop.onclick = () => fileIn.click();
  drop.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), fileIn.click());
  fileIn.onchange = () => fileIn.files[0] && upload(fileIn.files[0]);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]));

  async function upload(file) {
    $('#uerr').textContent = '';
    if (file.size > 10 * 1024 * 1024) { $('#uerr').textContent = 'File is larger than 10 MB.'; return; }
    $('#idle').classList.add('hidden');
    $('#busy').classList.remove('hidden');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Upload failed');
      startChat(data);
    } catch (e) {
      $('#uerr').textContent = e.message;
    } finally {
      $('#idle').classList.remove('hidden');
      $('#busy').classList.add('hidden');
      fileIn.value = '';
    }
  }

  function startChat(d) {
    docId = d.docId;
    history = [];
    $('#docName').textContent = d.name;
    $('#docMeta').textContent = `${d.pages} page${d.pages === 1 ? '' : 's'} · ${d.chunks} passages indexed`;
    $('#log').textContent = '';
    $('#upload').classList.add('hidden');
    $('#chat').classList.remove('hidden');
    bot('Your document is ready. Ask me anything about it. I will show the passages I used so you can check my answers.');
    const hints = document.createElement('div');
    hints.className = 'hints';
    for (const h of ['Summarize this document', 'What are the key points?', 'List any dates or numbers mentioned']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = h;
      b.onclick = () => ask(h);
      hints.append(b);
    }
    $('#log').append(hints);
    $('#q').focus();
  }

  $('#newDoc').onclick = () => {
    if (docId) fetch('/api/doc/' + docId, { method: 'DELETE' }).catch(() => {});
    docId = null;
    $('#chat').classList.add('hidden');
    $('#upload').classList.remove('hidden');
  };

  // ---------- chat ----------
  function scroll() { const l = $('#log'); l.scrollTop = l.scrollHeight; }
  function bubble(cls) {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    $('#log').append(el);
    return el;
  }
  function bot(text) { bubble('bot').textContent = text; scroll(); }

  /** Render answer text; turn [n] markers into buttons that open the matching source. Never uses innerHTML. */
  function renderAnswer(el, text, sources) {
    const frag = document.createDocumentFragment();
    text.split(/(\[\d+\])/g).forEach((part) => {
      const m = /^\[(\d+)\]$/.exec(part);
      if (m && sources.some((s) => s.n === +m[1])) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cite';
        b.textContent = m[1];
        b.setAttribute('aria-label', 'Show source ' + m[1]);
        b.onclick = () => {
          const d = el.querySelector(`details[data-n="${m[1]}"]`);
          if (!d) return;
          d.open = true;
          d.classList.add('flash');
          d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          setTimeout(() => d.classList.remove('flash'), 1400);
        };
        frag.append(b);
      } else if (part) frag.append(document.createTextNode(part));
    });
    el.append(frag);
    if (sources.length) {
      const box = document.createElement('div');
      box.className = 'srcs';
      for (const s of sources) {
        const d = document.createElement('details');
        d.className = 'src';
        d.dataset.n = s.n;
        const sm = document.createElement('summary');
        const b = document.createElement('b');
        b.textContent = `[${s.n}] `;
        sm.append(b, document.createTextNode(`page ${s.page} · match ${s.score}`));
        const p = document.createElement('p');
        p.textContent = s.text;
        d.append(sm, p);
        box.append(d);
      }
      el.append(box);
      // demo mode has no written answer (no [n] markers), so show the best passage right away
      if (!/\[\d+\]/.test(text)) box.querySelector('details').open = true;
    }
  }

  async function ask(text) {
    if (asking || !docId) return;
    text = text.trim();
    if (text.length < 2) return;
    asking = true;
    $('#send').disabled = true;
    document.querySelectorAll('.hints').forEach((h) => h.remove());
    bubble('user').textContent = text;
    const wait = bubble('bot');
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.innerHTML = '<span></span><span></span><span></span>'; // static markup, no user data
    wait.append(dots);
    scroll();
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId, question: text, history: history.slice(-6) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Request failed');
      wait.textContent = '';
      renderAnswer(wait, data.answer, data.sources || []);
      history.push({ role: 'user', text }, { role: 'assistant', text: data.answer });
    } catch (e) {
      wait.textContent = e.message;
      wait.classList.add('err');
    } finally {
      asking = false;
      $('#send').disabled = false;
      scroll();
      $('#q').focus();
    }
  }

  $('#form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#q').value;
    $('#q').value = '';
    $('#q').style.height = '';
    ask(v);
  };
  $('#q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); }
  });
  $('#q').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
  });
})();
