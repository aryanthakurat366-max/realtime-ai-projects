# Three new portfolio projects

| # | Project | Category | Folder |
|---|---------|----------|--------|
| 07 | **CollabBoard** — multiplayer whiteboard | Real-time (WebSockets) | `realtime-hub/` |
| 08 | **MeetUp** — peer-to-peer video calls | WebRTC | `realtime-hub/` (same server) |
| 09 | **DocChat** — chat with a PDF | AI (RAG with Gemini) | `docchat/` |

`portfolio/index.html` is your current portfolio with cards 07–09 added and the skills badge changed to "HLD & LLD Completed".

## Run locally

```bash
cd realtime-hub && npm install && npm start      # http://localhost:3000   (/collabboard/, /meetup/)
cd docchat      && npm install && npm start      # http://localhost:3001   (demo mode without a key)
GEMINI_API_KEY=your_key npm start                # inside docchat/ for the full AI mode
```
Camera/mic work on `localhost` and on HTTPS (Render gives you HTTPS). To test MeetUp alone, open two tabs with the same room code.

## Deploy (free)

1. Push this folder to a GitHub repo (the `.gitignore` already keeps `node_modules` and `.env` out).
2. On [Render](https://render.com): **New → Blueprint**, pick the repo. `render.yaml` creates both services.
3. In the `docchat` service, add the environment variable `GEMINI_API_KEY` (free key from Google AI Studio). Never put it in the code.
4. Copy the two `*.onrender.com` URLs into the three `YOUR-...` placeholders in `portfolio/index.html` and push it to your GitHub Pages repo.

Free Render services sleep after ~15 min idle, so the first load takes ~30 s (the cards already say so, like your BookMyShow card).

## How each one works (good for interviews)

**CollabBoard.** Every client draws on a fixed 1600x900 logical canvas, so coordinates mean the same thing on every screen size. Pointer movement is batched every 30 ms into one `segs` message (fewer WebSocket frames). The server keeps each stroke in a per-room map, so a late joiner receives the full board, and re-sends it after a reconnect. Cursor positions use `volatile` emits (dropping one is harmless). Undo removes only *your* last stroke. Server-side: input validation and clamping, ownership check on strokes, per-socket token-bucket rate limit, caps on strokes per room, empty rooms deleted after 15 min.

**MeetUp.** WebRTC is peer-to-peer, but peers must first exchange connection info, which is the job of the *signaling server* (Socket.IO). The newcomer creates an SDP offer for each existing peer; the answer and ICE candidates travel back through the server, which only relays them. Video/audio never touch the server. Chat and mic/camera status use an `RTCDataChannel`. Screen share uses `RTCRtpSender.replaceTrack`, so no renegotiation is needed. ICE candidates that arrive before the remote description are queued. It is a full mesh (each person uploads to everyone), which is why rooms are capped at 6; larger calls need an SFU. STUN is configured; add `TURN_URLS`/`TURN_USER`/`TURN_PASS` for users behind strict NATs.

**DocChat (RAG).** Indexing: extract text per page, split into ~900-character overlapping chunks (sentence-aware), embed each chunk with `gemini-embedding-001` (`RETRIEVAL_DOCUMENT`). Asking: embed the question (`RETRIEVAL_QUERY`), rank chunks by cosine similarity, put the top 5 into the prompt as numbered passages, and tell the model to answer only from them and cite `[n]`. The UI turns `[n]` into buttons that open the exact passage and page, so answers can be verified. The document text is treated as untrusted (the model is told not to follow instructions inside it). Without an API key it falls back to BM25 keyword retrieval. The API key stays on the server; uploads and questions are rate limited per IP.

## Tests

```bash
cd realtime-hub && npm test          # 17 protocol checks (rooms, validation, signaling, limits)
cd docchat && npm test               # 22 checks (chunking, BM25, full RAG path against a mock Gemini, upload safety)
node tests/browser.test.js           # real Chromium: two browsers do a live WebRTC call and share a drawing
```
The Gemini calls were tested against a mock server that mimics the REST API; **do one real test with your own key** after deploying. If the model name in `docchat/lib/rag.js` has been retired, set `GEMINI_MODEL` to a current one from <https://ai.google.dev/gemini-api/docs/models>.
