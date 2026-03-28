# The Architect

**The Architect** is a system design interview simulator: you explain a problem aloud (and optionally sketch it in Excalidraw), and the app returns interviewer-style feedback as text, diagram hints, and spoken hints via the browser’s text-to-speech API.

For the full product vision, data flow, and hackathon scope, see [DESIGN.md](./DESIGN.md).

## What’s in this repo

| Part | Stack | Role |
|------|--------|------|
| `frontend/` | Vite, React, TypeScript, Excalidraw | User pastes **GCP OAuth access token** (+ optional project ID), voice, canvas, feedback UI, TTS |
| `backend/` | FastAPI | Verifies token (CRM), stores token per session, calls **Vertex AI Gemini** with that token for `/get-feedback` |

**MVP problem:** URL shortener (bit.ly–style).

## Prerequisites

- **Node.js** 18+ and **Python** 3.12+
- A **GCP project** with **[Vertex AI API](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com)** enabled and billing (if required for your account)
- An **OAuth 2.0 access token** for your user with **`https://www.googleapis.com/auth/cloud-platform`** (or equivalent) so the same token can call Cloud Resource Manager and Vertex AI — for example:
  - `gcloud auth login` then `gcloud auth print-access-token`

## Run locally

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Optional tuning (defaults are usually fine):

- `VERTEX_AI_LOCATION` — default `us-central1`
- `VERTEX_GEMINI_MODEL` — default `gemini-2.5-flash`

The API listens on `http://127.0.0.1:8000`. Docs: `http://127.0.0.1:8000/docs`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5173`). The dev server proxies `/api` to the backend (`frontend/vite.config.ts`).

### 3. First-time flow in the UI

1. Paste your **access token** and, if you like, a **GCP project ID** (otherwise the backend uses the first project returned by `projects.list`).
2. Use **Start voice** or type in **Live transcript**, draw on the canvas, then **Get feedback** or **Auto feedback**.

The server keeps your token **in memory** for that session only (lost on restart). When the token expires, sign in again.

## Environment variables

### Backend

| Variable | Purpose |
|----------|---------|
| `CORS_ORIGINS` | Comma-separated allowed browser origins. Default: `http://localhost:5173,http://127.0.0.1:5173`. |
| `VERTEX_AI_LOCATION` | Vertex region (default `us-central1`). |
| `VERTEX_GEMINI_MODEL` | Publisher model id (default `gemini-2.5-flash`). |

There is **no** server-side Google API key: the **user-supplied OAuth access token** is used for Vertex AI.

### Frontend

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE` | Optional API base URL (no trailing slash). In dev, defaults to `/api` via the Vite proxy. |

## HTTP API (summary)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/verify-gcp` | Body: `{ "token": "...", "project_id"?: "..." }`. Validates token, picks project, stores credentials on session. Returns `session_id`, `project_id`. |
| `POST` | `/stream-voice` | Body: `{ "session_id", "transcript" }`. |
| `POST` | `/send-diagram` | Body: `{ "session_id", "diagram" }`. |
| `POST` | `/get-feedback` | Uses stored user token + project to call Vertex Gemini. **502** if Vertex returns an error (enable API, check model/region, IAM). |
| `GET` | `/health` | Liveness. |

## Docker (backend)

```bash
cd backend
docker build -t the-architect-api .
docker run -p 8000:8000 the-architect-api
```

Pass `CORS_ORIGINS` if the UI is on another host.

## Scripts

**Frontend:** `npm run dev` · `npm run build` · `npm run preview` · `npm run lint`  

**Backend:** `uvicorn main:app --reload` (from `backend/` with venv active)

## License

Add a license file if you plan to distribute the project.
