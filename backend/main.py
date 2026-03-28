"""
The Architect – FastAPI backend.
Session memory; user OAuth token verified via CRM and reused for Vertex AI (Gemini).
"""

from __future__ import annotations

import os
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ai_module import generate_feedback

app = FastAPI(title="The Architect", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(
        ","
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session: transcript + diagram (in-memory; MVP)
sessions: dict[str, dict[str, Any]] = {}


class VerifyBody(BaseModel):
    token: str = Field(default="", description="OAuth 2.0 access token (e.g. cloud-platform scope)")
    project_id: str | None = Field(
        default=None,
        description="GCP project ID for Vertex AI; if omitted, first project from CRM list is used",
    )


class VerifyResponse(BaseModel):
    valid: bool
    session_id: str
    project_id: str
    message: str


class StreamVoiceBody(BaseModel):
    session_id: str
    transcript: str = ""
    """Full or latest transcript from browser Web Speech API."""


class SendDiagramBody(BaseModel):
    session_id: str
    diagram: dict[str, Any]


class GetFeedbackBody(BaseModel):
    session_id: str
    transcript: str | None = None
    diagram: dict[str, Any] | None = None


class FeedbackResponse(BaseModel):
    text_feedback: str
    diagram_hints: list[str]
    voice_script: str
    mentioned_topics: list[str] = []


def _pick_project_id(crm_json: dict[str, Any], requested: str | None) -> str:
    projects = crm_json.get("projects") or []
    ids: list[str] = []
    for p in projects:
        if isinstance(p, dict) and p.get("projectId"):
            ids.append(str(p["projectId"]))
    want = (requested or "").strip() or None
    if want:
        if want not in ids:
            raise HTTPException(
                status_code=400,
                detail=f"project_id '{want}' is not among projects this token can access.",
            )
        return want
    if ids:
        return ids[0]
    raise HTTPException(
        status_code=403,
        detail="No accessible GCP projects for this token. Create a project or widen token scopes.",
    )


@app.post("/verify-gcp", response_model=VerifyResponse)
async def verify_gcp(body: VerifyBody) -> VerifyResponse:
    """Validate token with CRM, choose project for Vertex AI, store token on the session."""
    token = (body.token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token required")

    try:
        import httpx

        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                "https://cloudresourcemanager.googleapis.com/v1/projects",
                headers={"Authorization": f"Bearer {token}"},
            )
        if r.status_code != 200:
            raise HTTPException(
                status_code=401,
                detail="Token not accepted by Cloud Resource Manager. "
                "Use an OAuth access token with scope such as "
                "https://www.googleapis.com/auth/cloud-platform.readonly.",
            )
        crm = r.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Verification failed: {e!s}") from e

    try:
        project_id = _pick_project_id(crm if isinstance(crm, dict) else {}, body.project_id)
    except HTTPException:
        raise

    sid = str(uuid.uuid4())
    sessions[sid] = {
        "transcript": "",
        "diagram": None,
        "access_token": token,
        "project_id": project_id,
    }
    return VerifyResponse(
        valid=True,
        session_id=sid,
        project_id=project_id,
        message="GCP token verified; Vertex AI will use this token for feedback.",
    )


@app.post("/stream-voice")
async def stream_voice(body: StreamVoiceBody) -> dict[str, str]:
    """
    Receives transcript updates (browser STT) keyed by session.
    For full audio streaming with Cloud STT, extend with multipart/binary and user credentials.
    """
    if body.session_id not in sessions:
        raise HTTPException(status_code=404, detail="Invalid session")
    sessions[body.session_id]["transcript"] = body.transcript or ""
    return {"status": "ok"}


@app.post("/send-diagram")
async def send_diagram(body: SendDiagramBody) -> dict[str, str]:
    if body.session_id not in sessions:
        raise HTTPException(status_code=404, detail="Invalid session")
    sessions[body.session_id]["diagram"] = body.diagram
    return {"status": "ok"}


@app.post("/get-feedback", response_model=FeedbackResponse)
async def get_feedback(body: GetFeedbackBody) -> FeedbackResponse:
    if body.session_id not in sessions:
        raise HTTPException(status_code=404, detail="Invalid session")
    s = sessions[body.session_id]
    transcript = body.transcript if body.transcript is not None else s.get("transcript", "")
    diagram = body.diagram if body.diagram is not None else s.get("diagram")
    if body.transcript is not None:
        s["transcript"] = transcript
    if body.diagram is not None:
        s["diagram"] = diagram

    access_token = s.get("access_token")
    project_id = s.get("project_id")
    if not access_token or not project_id:
        raise HTTPException(
            status_code=503,
            detail="Session has no stored credentials. Sign in again with your GCP access token.",
        )
    try:
        result = await generate_feedback(
            transcript,
            diagram if isinstance(diagram, dict) else None,
            access_token=str(access_token),
            project_id=str(project_id),
        )
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI feedback failed: {e!s}") from e
    return FeedbackResponse(**result)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
