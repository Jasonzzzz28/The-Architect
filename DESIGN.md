# The Architect – Live System Design Interview AI

## **Overview**

**The Architect** is an AI-powered system design interview simulator that interacts **like a human interviewer**. It supports real-time voice input, diagram drawing, and provides feedback through **voice, text, and diagram annotations**. The goal is to create an interactive, multimodal interview experience for system design candidates.

**Use Case:**  
- Engineers preparing for system design interviews can practice explaining architectures while receiving **human-like, real-time feedback**.  
- Tracks covered: **Live Agent**, **AI / Cloud**, **Education / HR Tech**.

**Key Features:**  
1. Real-time **voice input** from the user.  
2. **Diagram drawing** via Excalidraw (services, DBs, arrows).  
3. AI **feedback via voice**, text hints, and diagram annotations.  
4. **User-provided GCP access token** to authenticate Google Cloud API usage.  
5. Web-based interface that works **locally** and on **Google Cloud**.  

---

## **System Architecture**

### **1️⃣ High-Level Architecture**
User (Browser)
├─ Input GCP Token → Frontend
├─ Voice Input → WebRTC / Web Speech API
├─ Diagram Input → Excalidraw JSON
↓
Frontend React App
├─ Verifies GCP token with backend
├─ Streams audio chunks to backend
├─ Sends diagram JSON
└─ Displays AI feedback (voice + text + diagram)
↓
FastAPI Backend (Cloud Run / Local)
├─ /verify-gcp → validate user token via Cloud Resource Manager
├─ /stream-voice → receives audio chunks
├─ /send-diagram → receives diagram JSON
├─ /get-feedback → returns AI-generated text + diagram feedback
├─ Speech-to-Text → uses user’s GCP token
├─ AI Reasoning → uses GenAI SDK with user token
├─ Text-to-Speech → uses user’s GCP token
↓
Frontend Feedback Display
├─ Plays AI voice feedback
├─ Shows text suggestions
└─ Highlights diagram annotations


---

### **2️⃣ Component Breakdown**

#### **Frontend**
- **React + Excalidraw**
  - Diagram drawing panel
  - Export/Import diagram JSON
- **Voice Input**
  - Browser-native Web Speech API / WebRTC for real-time audio capture
- **Feedback Panel**
  - Text suggestions streamed from backend
  - Optional diagram highlights
- **Voice Output**
  - Web Audio API for TTS playback
- **GCP Token Input**
  - Modal to input **OAuth token or service account JSON**
  - Sends token to backend for verification

#### **Backend**
- **FastAPI**
  - `/verify-gcp`: validates user token by calling Cloud Resource Manager or IAM API
  - `/stream-voice`: receives audio chunks
  - `/send-diagram`: receives diagram JSON
  - `/get-feedback`: returns AI-generated text + diagram feedback
- **AI Module**
  - Uses Google **GenAI SDK / Agent Development Kit**
  - Input: transcribed voice + diagram JSON
  - Output: incremental feedback (text + voice + diagram hints)
- **Speech-to-Text Module**
  - Uses **Google Cloud Speech-to-Text streaming** with user token
- **Text-to-Speech Module**
  - Uses **Cloud Text-to-Speech streaming** with user token
- **Optional Storage**
  - Cloud Storage for diagram snapshots or session replay

---

## **Tech Stack**

| Layer                  | Technology |
|------------------------|-----------|
| Frontend Framework     | React |
| Diagram Drawing        | Excalidraw |
| Voice Input            | WebRTC / Web Speech API |
| Voice Output (TTS)     | Google Cloud TTS / Browser SpeechSynthesis API |
| Backend Framework      | FastAPI (Python) |
| AI Reasoning           | Google GenAI SDK / Agent Dev Kit |
| Speech-to-Text         | Google Cloud Speech-to-Text streaming |
| Hosting                | Cloud Run / App Engine (Dockerized FastAPI) |
| Storage (optional)     | Cloud Storage (diagram snapshots) |
| GCP Authentication     | User-provided access token / OAuth 2.0 |

---

## **Data Flow & Workflow**

1. **GCP Access Token**
   - User enters GCP token in frontend
   - Backend verifies token via **Cloud Resource Manager / IAM**
   - Backend stores token in session memory for authenticated API calls

2. **User Input**
   - Speaks system design solution
   - Optionally draws diagram in Excalidraw

3. **Voice → Backend**
   - Audio streamed → Speech-to-Text using **user token**
   - Transcribed text is chunked for incremental AI processing

4. **Diagram → Backend**
   - Excalidraw JSON sent to backend
   - Backend parses JSON to identify missing components, connections, or labels

5. **AI Feedback**
   - GenAI Agent analyzes:
     - Spoken explanation (text)
     - Diagram JSON
   - Generates **incremental, real-time feedback**:
     - Text: suggestions, trade-offs, missing pieces
     - Diagram: highlight missing services, arrows, labels
     - Voice: TTS output streamed back to frontend

6. **Frontend Display**
   - Plays AI voice feedback immediately
   - Displays text suggestions live
   - Highlights diagram annotations

---

## **MVP Scope**

**In-Scope:**
- Real-time voice input + AI feedback via voice
- Diagram drawing and JSON feedback
- Text feedback panel
- User-provided GCP token for all Google Cloud API calls
- Single system design problem template (e.g., URL shortener)

**Out-of-Scope (Hackathon MVP):**
- Multi-problem support
- Complex diagram image recognition
- Real-time voice transcription <100ms latency
- User accounts or database persistence beyond session memory

---

## **Local Testing Strategy**

- **Environment Setup:**
  - Create and activate a Python virtual environment:
    ```bash
    python -m venv venv
    source venv/bin/activate   # macOS / Linux
    venv\Scripts\activate      # Windows
    ```
  - Install dependencies:
    ```bash
    pip install -r requirements.txt
    ```

- **Frontend:**
  - Use **Web Speech API** for local Speech-to-Text (STT)
  - Use **SpeechSynthesis API** for local Text-to-Speech (TTS)

- **Backend:**
  - Run FastAPI locally:
    ```bash
    uvicorn main:app --reload
    ```
  - AI module uses **Vertex AI Gemini** with the **same user OAuth access token** (no server API key)

- **Diagram:**
  - Process **Excalidraw JSON** directly on the backend
  - Provide feedback as text hints (no complex annotations needed for MVP)

- **GCP Token:**
  - Token verification uses **Cloud Resource Manager** (`projects.list`) with the user’s OAuth access token

---

## **Cloud Deployment Strategy**

- Package backend in **Dockerfile**
- Deploy to **Cloud Run** for auto-scaling
- Use:
  - **User’s GCP token** for authenticating:
    - Cloud Speech-to-Text streaming
    - GenAI SDK / Agent Dev Kit
    - Cloud Text-to-Speech streaming
- Frontend served locally or via **Cloud Storage / Vercel / Netlify**

---

## **UX Flow Example**

1. User inputs GCP token → backend verifies → session token stored  
2. User starts speaking: “I would design a chat system with horizontal scaling and message queues.”  
3. AI responds in voice: “Great start! Consider adding message ordering in your queues.”  
4. User draws diagram: DB, API, queues, load balancer  
5. AI diagram feedback: “Label the message queue properly; add arrow from cache to DB.”  
6. Text hints appear: “Consider caching recent messages to reduce DB load.”  

---

## **Hackathon Considerations**
- **Demo Impact:** Voice + text + diagram = highly interactive, human-like interview
- **Scope Control:** Start with **one system design template**
- **Local Dev First:** Fast iteration → swap in Google Cloud APIs for hackathon demo
- **Incremental Feedback:** 2–3 second streaming intervals simulate live conversation
- **User Token:** Allows personalized, secure Google Cloud API usage

---

## **Next Steps**
1. Setup **React + Excalidraw frontend**
2. Build **FastAPI backend** with streaming voice, diagram, and token verification
3. Implement **AI module** (Gemini / GenAI)
4. Integrate **TTS for voice feedback**
5. Test locally with a real user access token (Vertex-enabled project) → deploy backend to **Cloud Run**
6. Prepare **demo flow** for hackathon judges

---

## **References / Resources**
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Excalidraw GitHub](https://github.com/excalidraw/excalidraw)
- [Google Cloud GenAI SDK](https://developers.google.com/ai)
- [Cloud Speech-to-Text Streaming](https://cloud.google.com/speech-to-text/docs/streaming-recognize)
- [Cloud Text-to-Speech Streaming](https://cloud.google.com/text-to-speech/docs/streaming)
- [Cloud Resource Manager API](https://cloud.google.com/resource-manager/docs)
- [IAM API](https://cloud.google.com/iam/docs/reference/rest)