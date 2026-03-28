# Gemini Live API — Real-Time Auto-Feedback (MVP Design)

This document describes an MVP to replace the **fixed-interval** auto-feedback (`get-feedback` every ~9s) with **streaming, session-based** interaction using Google’s **Gemini Live API** (multimodal live over **WebSockets**).

**References:** [Gemini Live API overview (Google AI)](https://ai.google.dev/gemini-api/docs/multimodal-live), [Live API WebSockets](https://ai.google.dev/api/live), [Vertex AI Live API](https://cloud.google.com/vertex-ai/generative-ai/docs/live-api).

---

## 1. Problem & goal

**Today:** Auto-feedback polls REST `get-feedback` on a timer with the latest transcript + Excalidraw JSON. Latency is bounded by the poll interval and full round-trip per request; there is no true conversational “turn-taking” or streaming partials.

**Goal (MVP):** While **auto-feedback** is on, maintain a **single long-lived Live session** that:

- Ingests **user input in near real time** (at minimum **text**; stretch **audio**).
- Streams **interviewer feedback** back as **incremental text** (and optionally **audio** later).
- Optionally receives **diagram context** as **text (JSON summary)** or **low-rate image** (JPEG), per Live API limits (e.g. images ≲ 1 FPS).

**Non-goals (MVP):**

- Replacing the existing REST `get-feedback` path for manual “Get feedback” (can remain for simplicity).
- Full diagram pixel streaming or high-FPS video.
- Multi-user or persisted Live sessions across server restarts.
- Production-hardened scaling (single Live session per browser tab is enough for MVP).

---

## 2. Gemini Live API (relevant facts)

| Topic | Detail |
|--------|--------|
| **Transport** | Stateful **WebSocket** (WSS). |
| **Inputs** | Text; **PCM audio** (e.g. 16-bit LE, 16 kHz); **JPEG** images at low frame rate. |
| **Outputs** | Streaming **text**; **PCM audio** (e.g. 24 kHz) for voice replies. |
| **Features** | Barge-in, tool use, **audio transcriptions** (user/model), proactive audio controls. |

**Implementation choices (from Google):**

- **Client → Google directly:** Lower latency for mic audio; production should use **ephemeral tokens** (not long-lived API keys in the browser).
- **Client → your backend → Google:** Easier to centralize auth (e.g. **Vertex** + user OAuth on the server), at the cost of an extra network hop for streaming.

---

## 3. Alignment with The Architect today

| Current piece | Live MVP note |
|---------------|----------------|
| User **GCP OAuth access token** + **project** for Vertex | Vertex exposes a **Live API**; MVP should define whether Live uses the **same** user token (server-side WSS) or a **short-lived token** minted by the backend. |
| **Web Speech API** transcript | Can stay for captioning; **or** rely on Live **input transcription** if sending native audio to Live. |
| **Excalidraw JSON** | Send as **truncated JSON in text** messages on a **debounce** (e.g. 1–2 s) or as **JPEG snapshot** ≤ 1 FPS. |
| **Feedback UI** | **Text:** append or replace a “streaming” region. **Audio:** play PCM via **Web Audio** (decode / worklet) when enabled. |
| **9s `setInterval`** | **Removed** for auto-feedback when Live is active; replaced by **WebSocket-driven** updates. |

---

## 4. Recommended MVP architecture

**Choice: server-mediated WebSocket (two hops).**

1. **Browser** opens a **WebSocket to FastAPI** (`wss://…/ws/live` or `ws://` locally).
2. **FastAPI** opens a **second WebSocket** to **Vertex Gemini Live** (or Google AI Live, if you introduce API keys for a hackathon path) using credentials derived from the **existing verified session** (user access token + project id stored server-side).
3. **Browser** sends: **text chunks** (transcript deltas), optional **binary PCM** (if you add mic capture), optional **diagram JSON** or **base64 JPEG**.
4. **FastAPI** forwards to Live and **streams back** model events (text deltas, optional audio, optional transcriptions) to the client.

**Why this for MVP:** Matches the product’s **“user-provided GCP access”** story without putting long-lived secrets in the frontend. Latency is acceptable for an MVP if text-first; add **client-direct + ephemeral tokens** as a **Phase 2** optimization for audio.

---

## 5. Session & authentication (MVP)

1. User completes existing **`/verify-gcp`** → server stores `access_token`, `project_id`, `session_id` (in-memory today).
2. Client calls **`POST /live/start`** (or first WS message) with `session_id`:
   - Server validates session.
   - Server opens Live WebSocket with Vertex using project + user token (or refreshed credential if you add refresh later).
3. On disconnect or token expiry: close Live socket; client shows **“Reconnect”** or re-run verify.

**Open decision (document in implementation):** Exact Vertex Live **endpoint**, **model id** (e.g. a `gemini-live-*` / native-audio model per current docs), and **required IAM** (`aiplatform.endpoints.predict` or Live-specific roles).

---

## 6. System prompt (Live session)

Reuse the **URL shortener** problem statement from `ai_module.py`. The Live system instruction is **turn-taking**: default **silence**, explicit triggers (opening, question, feedback request, rare checkpoint). Implemented in `backend/live_bridge.py`. Full product spec: [LIVE_INTERVIEWER_BEHAVIOR.md](./LIVE_INTERVIEWER_BEHAVIOR.md).

---

## 7. Client behavior (MVP)

| Control | Behavior |
|---------|----------|
| **Auto feedback off** | No Live socket; existing manual REST flow unchanged. |
| **Auto feedback on** | Connect Live; after `setupComplete`, send **one** session-start user turn (T0 opening). **Debounced** context updates (~3 s after transcript/diagram stabilizes; ~0.6 s if transcript looks like a question or feedback ask). **Nudge interviewer** sends an explicit “respond now” turn. |
| **Stop auto / unmount** | Close WS; server closes upstream Live. |
| **Mic** | MVP: **browser STT → text into Live**; Phase 2: raw **PCM** into Live for lower latency. |
| **TTS** | Manual REST **Get feedback** uses browser TTS; Live path uses **native audio** from the model. |

---

## 8. Backend surface (MVP)

| Piece | Responsibility |
|-------|------------------|
| **`WS /ws/live?session_id=…`** | Authz session; bridge to Vertex Live; binary/text frames from client ↔ Live. |
| **(Optional) `POST /live/start`** | Eager connect + return connection id if you prefer not to pass `session_id` only on WS. |
| **Heartbeat / ping** | Keep proxies from closing idle connections. |
| **Logging** | Minimal: connect, disconnect, errors (no full token logging). |

---

## 9. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| **Token expiry** mid-session | Short MVP: reconnect + re-verify; later: refresh tokens. |
| **Cost / quota** | One session per tab; document model choice; add kill switch. |
| **Latency via backend** | MVP accept; Phase 2 ephemeral client tokens + direct WSS. |
| **Diagram as JSON size** | Truncate + summarize; prefer JPEG only if needed. |

---

## 10. Implementation phases (suggested)

1. **Phase 1 — Text-only Live bridge:** WS proxy, transcript streaming, incremental text in feedback panel; auto-feedback toggles Live instead of `setInterval`.
2. **Phase 2 — Diagram in loop:** Debounced JSON (and optional JPEG) messages.
3. **Phase 3 — Audio:** Client PCM → server → Live; Live PCM → Web Audio playback; consider ephemeral tokens + direct client path if latency matters.

---

## 11. Success criteria (MVP)

- With **auto-feedback on**, user sees **streaming** interviewer text (or clear chunked updates) **without** a fixed 9-second poll.
- **No** user API key in the browser; auth remains **server-side** using existing session credentials.
- Graceful behavior on **disconnect** (session expired, network loss): user can recover by toggling auto-feedback or signing in again.

---

## 12. Doc maintenance

When implementation lands, update **`README.md`** with how to enable Live, required **Vertex** APIs/IAM, and any new env vars (model id, region). Keep this file as the **intent/architecture** reference; link from **`DESIGN.md`** if desired.
