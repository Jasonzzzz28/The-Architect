"""
The Architect – FastAPI backend.
Session memory; user OAuth token verified via CRM and reused for Vertex AI (Gemini).
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ai_module import generate_feedback
from design_problems import (
    context_for_custom,
    context_for_preset,
    default_problem_context,
    display_for,
    list_presets_public,
)
from live_bridge import run_live_bridge

logger = logging.getLogger(__name__)


def _configure_app_logging() -> None:
    """Uvicorn often leaves the root logger at WARNING; app INFO would be dropped."""
    fmt = logging.Formatter("%(levelname)s [%(name)s] %(message)s")
    for name in ("main", "live_bridge"):
        lg = logging.getLogger(name)
        lg.setLevel(logging.INFO)
        if lg.handlers:
            continue
        h = logging.StreamHandler()
        h.setFormatter(fmt)
        lg.addHandler(h)
        lg.propagate = False


_configure_app_logging()

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


class SetDesignProblemBody(BaseModel):
    session_id: str = Field(description="Session from /verify-gcp")
    preset_id: str | None = Field(
        default=None,
        description="One of: url_shortener, youtube, twitter_feed, rate_limiter, ticket_booking",
    )
    custom_problem: str | None = Field(
        default=None,
        description="If non-empty, overrides preset_id with a custom problem statement",
    )


class SetDesignProblemResponse(BaseModel):
    problem_id: str
    title: str
    summary: str


class DesignPreset(BaseModel):
    id: str
    title: str
    summary: str


class DesignProblemsResponse(BaseModel):
    presets: list[DesignPreset]


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
    def_pid, def_ctx = default_problem_context()
    sessions[sid] = {
        "transcript": "",
        "diagram": None,
        "access_token": token,
        "project_id": project_id,
        "problem_id": def_pid,
        "problem_context": def_ctx,
        "custom_problem": None,
    }
    return VerifyResponse(
        valid=True,
        session_id=sid,
        project_id=project_id,
        message="GCP token verified; Vertex AI will use this token for feedback.",
    )


@app.get("/design-problems", response_model=DesignProblemsResponse)
async def design_problems() -> DesignProblemsResponse:
    rows = list_presets_public()
    return DesignProblemsResponse(
        presets=[DesignPreset(id=r["id"], title=r["title"], summary=r["summary"]) for r in rows],
    )


@app.post("/session/design-problem", response_model=SetDesignProblemResponse)
async def set_design_problem(body: SetDesignProblemBody) -> SetDesignProblemResponse:
    if body.session_id not in sessions:
        raise HTTPException(status_code=404, detail="Invalid session")
    s = sessions[body.session_id]
    custom = (body.custom_problem or "").strip()
    if custom:
        try:
            ctx = context_for_custom(custom)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        s["problem_id"] = "custom"
        s["custom_problem"] = custom
        s["problem_context"] = ctx
        title, summary = display_for("custom", custom)
    else:
        pid = (body.preset_id or "").strip()
        if not pid:
            raise HTTPException(
                status_code=400,
                detail="Provide preset_id or a non-empty custom_problem",
            )
        try:
            ctx = context_for_preset(pid)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        s["problem_id"] = pid
        s["custom_problem"] = None
        s["problem_context"] = ctx
        title, summary = display_for(pid, None)
    return SetDesignProblemResponse(problem_id=s["problem_id"], title=title, summary=summary)


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
    problem_ctx = s.get("problem_context")
    if not isinstance(problem_ctx, str) or not problem_ctx.strip():
        _, problem_ctx = default_problem_context()

    try:
        result = await generate_feedback(
            transcript,
            diagram if isinstance(diagram, dict) else None,
            access_token=str(access_token),
            project_id=str(project_id),
            problem_context=str(problem_ctx),
        )
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI feedback failed: {e!s}") from e
    return FeedbackResponse(**result)


@app.websocket("/ws/live")
async def websocket_live(websocket: WebSocket, session_id: str) -> None:
    """
    Browser <-> Vertex Gemini Live (BidiGenerateContent). Requires valid session with access_token.
    Client sends JSON frames in Live API format (e.g. client_content). Server forwards Vertex responses.
    """
    tag = session_id[:8] if len(session_id) >= 8 else session_id
    await websocket.accept()
    logger.info("ws/live accepted session_id=%s…", tag)
    if session_id not in sessions:
        logger.warning("ws/live closing: invalid session_id=%s…", tag)
        try:
            await websocket.close(code=4000, reason="Invalid session")
        except WebSocketException:
            pass
        return
    s = sessions[session_id]
    token = s.get("access_token")
    project_id = s.get("project_id")
    if not token or not project_id:
        logger.warning(
            "ws/live closing: session %s… missing token=%s project_id=%s",
            tag,
            bool(token),
            bool(project_id),
        )
        try:
            await websocket.close(code=4001, reason="Session missing credentials")
        except WebSocketException:
            pass
        return
    logger.info(
        "ws/live starting bridge session=%s… project_id=%s",
        tag,
        project_id,
    )
    problem_ctx = s.get("problem_context")
    if not isinstance(problem_ctx, str) or not problem_ctx.strip():
        _, problem_ctx = default_problem_context()
    await run_live_bridge(
        websocket,
        str(token),
        str(project_id),
        problem_context=str(problem_ctx),
        client_tag=tag,
    )
    logger.info("ws/live bridge returned session=%s…", tag)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
