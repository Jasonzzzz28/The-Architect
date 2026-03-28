"""Named design interview problems and custom prompt wrapping for AI + Live."""

from __future__ import annotations

MAX_CUSTOM_PROBLEM_LEN = 3000

DEFAULT_PRESET_ID = "url_shortener"

_TRAIL = (
    "Encourage relevant trade-offs (scale, consistency, failure modes, APIs) where they matter for this problem."
)

_PRESETS: dict[str, dict[str, str]] = {
    "url_shortener": {
        "title": "URL shortener",
        "summary": (
            "Create short links, fast redirects, and sensible scale (millions of links, high read traffic)."
        ),
        "context": """Design a URL shortener (e.g., bit.ly style) that supports:
- Creating short URLs from long URLs
- Redirects with low latency
- Reasonable scale (millions of links, high read traffic)
Encourage trade-offs: hashing vs DB IDs, cache, DB choice, rate limits, analytics.""",
    },
    "youtube": {
        "title": "Design YouTube",
        "summary": (
            "Video upload, encoding/transcoding, storage, CDN delivery, recommendations at scale, "
            "and metadata/search."
        ),
        "context": """Design a YouTube-like video platform including:
- Upload and ingest; transcoding / adaptive bitrate; storage and CDN for playback
- Metadata, search, and basic recommendations
- Scale: huge catalog, global viewers, hot videos
Probe caching, encoding pipelines, cost, and consistency models.""",
    },
    "twitter_feed": {
        "title": "Design Twitter News Feed",
        "summary": (
            "Fan-out on write vs read, timeline generation, ranking, and real-time feel at large scale."
        ),
        "context": """Design the core of a Twitter-style home timeline / news feed:
- Users follow many accounts; tweets must appear in followers' feeds with low latency
- Mix of celebrities (many followers) and normal users
- Ranking, pagination, and rough real-time updates
Discuss fan-out, storage, caching, and hot-key mitigation.""",
    },
    "rate_limiter": {
        "title": "Rate Limiter",
        "summary": (
            "Distributed rate limiting (token bucket / sliding window), accuracy vs memory, and API gateway use."
        ),
        "context": """Design a distributed rate limiter for an API gateway:
- Per user / per IP / per API key with configurable limits
- Accurate enough for abuse prevention; low latency on the critical path
- Multi-region or clustered services
Compare algorithms (token bucket, sliding window, fixed window), storage (Redis, in-memory), and sync.""",
    },
    "ticket_booking": {
        "title": "Ticket Booking System",
        "summary": (
            "Seat inventory, concurrency, payments, and avoiding double-booking under load."
        ),
        "context": """Design a ticket booking system (concerts, trains, or similar):
- Browse events, seat maps or inventory, purchase flow
- Prevent double-booking and overselling under concurrent requests
- Idempotent payments and holding reservations
Discuss transactions, locks, queues, and scaling popular on-sales.""",
    },
}


def list_presets_public() -> list[dict[str, str]]:
    """id, title, summary for API clients (no full interviewer prompt)."""
    return [
        {"id": pid, "title": v["title"], "summary": v["summary"]}
        for pid, v in _PRESETS.items()
    ]


def _wrap_problem(body: str) -> str:
    return (
        "You are a senior staff engineer conducting a system design interview.\n"
        f"{body.strip()}\n\n{_TRAIL}"
    )


def context_for_preset(preset_id: str) -> str:
    if preset_id not in _PRESETS:
        raise ValueError(f"Unknown preset_id: {preset_id}")
    return _wrap_problem(_PRESETS[preset_id]["context"])


def context_for_custom(text: str) -> str:
    raw = text.strip()
    if not raw:
        raise ValueError("custom_problem is empty")
    if len(raw) > MAX_CUSTOM_PROBLEM_LEN:
        raise ValueError(f"custom_problem exceeds {MAX_CUSTOM_PROBLEM_LEN} characters")
    return _wrap_problem(
        "The candidate chose a custom design topic. Treat the following as the problem statement:\n\n"
        f"{raw}"
    )


def default_problem_context() -> tuple[str, str]:
    """(preset_id, full_context_for_ai)."""
    return DEFAULT_PRESET_ID, context_for_preset(DEFAULT_PRESET_ID)


def display_for(preset_id: str, custom: str | None) -> tuple[str, str]:
    """(title, summary) for UI and Live T0."""
    if preset_id == "custom" and (custom or "").strip():
        raw = (custom or "").strip()
        first = raw.split("\n")[0].strip()
        title = "Custom design problem"
        summary = first if len(first) <= 220 else first[:217] + "…"
        return title, summary
    if preset_id in _PRESETS:
        p = _PRESETS[preset_id]
        return p["title"], p["summary"]
    return "System design", "Walk through your approach and ask for requirements."
