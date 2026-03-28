"""Interview feedback via Vertex AI Gemini using the user's OAuth access token."""

from __future__ import annotations

import json
import os
import re
from typing import Any


async def generate_feedback(
    transcript: str,
    diagram: dict[str, Any] | None,
    *,
    access_token: str,
    project_id: str,
    problem_context: str,
) -> dict[str, Any]:
    token = access_token.strip()
    if not token:
        raise ValueError("Access token is missing.")
    pid = project_id.strip()
    if not pid:
        raise ValueError("GCP project ID is missing.")
    return await _vertex_gemini_feedback(
        transcript, diagram, token, pid, problem_context.strip()
    )


async def _vertex_gemini_feedback(
    transcript: str,
    diagram: dict[str, Any] | None,
    access_token: str,
    project_id: str,
    problem_context: str,
) -> dict[str, Any]:
    import httpx

    location = (os.environ.get("VERTEX_AI_LOCATION") or "us-central1").strip() or "us-central1"
    model = (os.environ.get("VERTEX_GEMINI_MODEL") or "gemini-2.5-flash").strip() or "gemini-2.5-flash" 

    diagram_str = json.dumps(diagram or {}, default=str)[:12000]
    pc = problem_context or "You are a senior staff engineer conducting a system design interview."
    user_prompt = f"""{pc}

Candidate spoken explanation (may be partial):
{transcript or "(none yet)"}

Excalidraw/diagram JSON summary (truncated):
{diagram_str}

Respond as JSON only with keys:
- text_feedback: string, 2-4 short paragraphs of interviewer-style feedback
- diagram_hints: array of strings, concrete diagram suggestions
- voice_script: string, one short sentence suitable for text-to-speech (under 300 chars)
"""

    host = f"{location}-aiplatform.googleapis.com"
    url = (
        f"https://{host}/v1/projects/{project_id}/locations/{location}"
        f"/publishers/google/models/{model}:generateContent"
    )

    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": 0.6,
            "responseMimeType": "application/json",
        },
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        if r.status_code != 200:
            detail = r.text[:2000]
            raise RuntimeError(
                f"Vertex AI returned {r.status_code}. "
                f"Ensure Vertex AI API is enabled on project {project_id}, "
                f"the token has scope https://www.googleapis.com/auth/cloud-platform, "
                f"and model {model} is available in {location}. Body: {detail}"
            )
        data = r.json()

    text = (
        data.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
    )
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    parsed = json.loads(text)
    return {
        "text_feedback": parsed.get("text_feedback", ""),
        "diagram_hints": list(parsed.get("diagram_hints") or []),
        "voice_script": (parsed.get("voice_script") or "")[:500],
        "mentioned_topics": [],
    }
