"""
Vertex AI Gemini Live API WebSocket bridge (server-mediated).
Proxies browser <-> wss://{location}-aiplatform.googleapis.com/.../BidiGenerateContent
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl
from typing import Any

import certifi
import websockets
from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

LIVE_INSTRUCTION_SUFFIX = """

## Live session — interviewer conduct (follow strictly)

You are a **staff+ system design interviewer** for the problem above. **Spoken** output only when appropriate; calm, concise, no lecturing.

### Default
The candidate’s **speech is streamed as raw audio**; use the session’s **voice-activity / end-of-speech** signals to treat a **turn** as complete before you reply—do not respond in the middle of an utterance unless the server marks an end-of-turn. **Stay silent** until a trigger applies. Do **not** fill dead air, narrate the canvas, or comment on every small change.

### Triggers (speak **once** per trigger, then stop)

- **T0 — Session start:** The user message explicitly marks session start. Give **one** short opening: restate the problem in 1–2 sentences, say they should walk you through the design and ask you for requirements or constraints, then **stop**. **Never repeat or restart this opening** if you already delivered it—new context messages are not a new session.

- **T1 — Direct question:** The candidate’s latest words contain a **question** or clear request for information. They may **not** use a question mark (speech transcription often drops it)—treat WH-questions, modals (“should I…”, “how would you…”, “can we…”), and “not sure / wondering” as questions. **Answer only that**, briefly, then stop.

- **T2 — Explicit feedback request:** They ask for your opinion, feedback, or what’s missing (e.g. “what do you think?”, “any feedback?”, “anything I’m missing?”). Give **focused** feedback, then stop.

- **T3 — Rare checkpoint:** Only when the message says you may respond for a **high-value checkpoint** *and* they have clearly finished a thought or subsection. **One** short nudge (gap, scale, consistency)—not trivia. If nothing important to say, **say nothing**.

### Anti-patterns
Never read back long transcripts. Do not react to every diagram JSON update. Do not stack multiple unrelated points in one turn unless they asked a broad question. **Do not loop** the same sentence—if audio or generation glitches, finish the thought briefly and end the turn.
"""


def live_system_prompt(problem_context: str) -> str:
    base = (problem_context or "").strip() or (
        "You are a senior staff engineer conducting a system design interview."
    )
    return base + LIVE_INSTRUCTION_SUFFIX


def _vertex_live_url(location: str) -> str:
    host = f"{location}-aiplatform.googleapis.com"
    return (
        f"wss://{host}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
    )


def build_setup_message(
    project_id: str,
    location: str,
    model: str,
    voice_name: str,
    *,
    problem_context: str,
) -> dict[str, Any]:
    model_uri = f"projects/{project_id}/locations/{location}/publishers/google/models/{model}"
    return {
        "setup": {
            "model": model_uri,
            "generation_config": {
                "response_modalities": ["AUDIO"],
                "temperature": 0.6,
                "speech_config": {
                    "voice_config": {
                        "prebuilt_voice_config": {
                            "voice_name": voice_name,
                        },
                    },
                },
            },
            "system_instruction": {
                "parts": [{"text": live_system_prompt(problem_context)}],
            },
            "proactivity": {"proactiveAudio": False},
            "input_audio_transcription": {},
            "output_audio_transcription": {},
            "realtime_input_config": {
                "automatic_activity_detection": {
                    "disabled": False,
                    "silence_duration_ms": 1200,
                    "prefix_padding_ms": 400,
                    "end_of_speech_sensitivity": "END_SENSITIVITY_UNSPECIFIED",
                    "start_of_speech_sensitivity": "START_SENSITIVITY_UNSPECIFIED",
                },
                "activity_handling": "ACTIVITY_HANDLING_UNSPECIFIED",
            },
        },
    }


async def _forward_client_to_vertex(browser_ws: WebSocket, upstream: Any, client_tag: str) -> None:
    try:
        logger.info("[%s] client->vertex: waiting for first browser frame", client_tag)
        while True:
            text = await browser_ws.receive_text()
            logger.debug("[%s] client->vertex: forwarded %d bytes", client_tag, len(text))
            await upstream.send(text)
    except WebSocketDisconnect as e:
        logger.info(
            "[%s] client->vertex: browser disconnected code=%s",
            client_tag,
            getattr(e, "code", None),
        )
    except Exception as e:
        logger.warning("[%s] client->vertex: %s", client_tag, e, exc_info=True)


async def _forward_vertex_to_browser(browser_ws: WebSocket, upstream: Any, client_tag: str) -> None:
    n = 0
    try:
        async for message in upstream:
            n += 1
            if n == 1:
                preview = message[:500] if isinstance(message, (bytes, bytearray)) else str(message)[:500]
                logger.info(
                    "[%s] vertex->client: first frame (%s) len=%d preview=%r",
                    client_tag,
                    type(message).__name__,
                    len(message),
                    preview,
                )
            # Vertex sends JSON as UTF-8; the websockets client often yields `bytes`.
            # Browsers only auto-parse text frames — binary frames become Blob and break JSON.parse.
            if isinstance(message, (bytes, bytearray)):
                try:
                    await browser_ws.send_text(bytes(message).decode("utf-8"))
                except UnicodeDecodeError:
                    await browser_ws.send_bytes(bytes(message))
            else:
                await browser_ws.send_text(str(message))
        logger.info("[%s] vertex->client: upstream iteration ended after %d frame(s)", client_tag, n)
    except websockets.exceptions.ConnectionClosed as e:
        logger.info(
            "[%s] vertex->client: upstream ConnectionClosed code=%s reason=%r",
            client_tag,
            e.code,
            e.reason,
        )
    except Exception as e:
        logger.warning("[%s] vertex->client: %s", client_tag, e, exc_info=True)


async def run_live_bridge(
    browser_ws: WebSocket,
    access_token: str,
    project_id: str,
    *,
    problem_context: str,
    client_tag: str = "—",
) -> None:
    location = (os.environ.get("VERTEX_AI_LOCATION") or "us-central1").strip() or "us-central1"
    model = (os.environ.get("VERTEX_LIVE_MODEL") or "gemini-live-2.5-flash-native-audio").strip()
    voice = (os.environ.get("VERTEX_LIVE_VOICE") or "Puck").strip() or "Puck"

    url = _vertex_live_url(location)
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }

    logger.info(
        "[%s] live_bridge: connecting upstream host=%s location=%s model=%s token_len=%d",
        client_tag,
        url.split("/")[2],
        location,
        model,
        len(access_token),
    )

    try:
        async with websockets.connect(
            url,
            additional_headers=headers,
            ssl=ssl_context,
            max_size=None,
        ) as upstream:
            logger.info("[%s] live_bridge: upstream WebSocket open", client_tag)
            setup = build_setup_message(
                project_id, location, model, voice, problem_context=problem_context
            )
            setup_raw = json.dumps(setup)
            await upstream.send(setup_raw)
            logger.info(
                "[%s] live_bridge: setup JSON sent (%d bytes) model=%s voice=%s (AUDIO + output transcription)",
                client_tag,
                len(setup_raw),
                model,
                voice,
            )

            to_v = asyncio.create_task(
                _forward_client_to_vertex(browser_ws, upstream, client_tag),
                name=f"live-{client_tag}-client-to-vertex",
            )
            to_b = asyncio.create_task(
                _forward_vertex_to_browser(browser_ws, upstream, client_tag),
                name=f"live-{client_tag}-vertex-to-client",
            )
            done, pending = await asyncio.wait(
                (to_v, to_b),
                return_when=asyncio.FIRST_COMPLETED,
            )
            first = next(iter(done))
            logger.info(
                "[%s] live_bridge: first completed task=%s cancelled=%s",
                client_tag,
                first.get_name(),
                first.cancelled(),
            )
            if not first.cancelled() and first.exception() is not None:
                exc = first.exception()
                if isinstance(exc, WebSocketDisconnect):
                    logger.info("[%s] live_bridge: first task ended with WebSocketDisconnect", client_tag)
                else:
                    logger.warning(
                        "[%s] live_bridge: first task failed: %s",
                        client_tag,
                        exc,
                        exc_info=(type(exc), exc, exc.__traceback__),
                    )
            for t in pending:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
            logger.info("[%s] live_bridge: upstream context exiting (cancelled peer relay)", client_tag)
    except websockets.exceptions.InvalidStatus as e:
        code = e.response.status_code
        logger.warning(
            "[%s] live_bridge: upstream rejected handshake HTTP %s (%s)",
            client_tag,
            code,
            e,
        )
        try:
            await browser_ws.send_text(
                json.dumps(
                    {
                        "architect_error": f"Vertex Live connection failed: HTTP {code}. "
                        "Check Vertex AI API, model name, region, and token scopes."
                    }
                )
            )
        except Exception as send_exc:
            logger.warning("[%s] live_bridge: could not send architect_error to client: %s", client_tag, send_exc)
    except Exception as e:
        logger.exception("[%s] live_bridge: failed before or during relay", client_tag)
        try:
            await browser_ws.send_text(
                json.dumps({"architect_error": f"Live bridge error: {e!s}"})
            )
        except Exception as send_exc:
            logger.warning("[%s] live_bridge: could not send architect_error: %s", client_tag, send_exc)
    finally:
        logger.info("[%s] live_bridge: closing browser WebSocket", client_tag)
        try:
            await browser_ws.close()
        except Exception as close_exc:
            logger.debug("[%s] live_bridge: browser close: %s", client_tag, close_exc)
