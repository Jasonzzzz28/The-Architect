# Live interviewer behavior — design (realistic turn-taking)

This document describes how to move the **Gemini Live** path from “always narrating” to **interviewer-like** behavior: an opening, answers to questions, and feedback **when warranted** or **on request**.

---

## 1. What feels wrong today

Several things stack up so the model tends to **speak continuously**:

| Factor | Effect |
|--------|--------|
| **Frequent `client_content` pushes** | The client throttles (~450 ms) and sends the **full** transcript + diagram on **every** transcript/diagram change. The model treats each push as new input and often **responds again**. |
| **System prompt** | It tells the model to give **incremental** interviewer feedback in real time, which encourages **ongoing** commentary. |
| **Native audio + Live defaults** | Models tuned for conversational audio may **proactively** continue the “conversation” unless the session is configured and prompted for **restraint**. |
| **No explicit “wait” rule** | There is no strong norm: *default to silence until a trigger fires*. |

So the fix is **not** only a nicer paragraph in the prompt; it is **prompt + triggers + (optionally) API knobs**.

---

## 2. Target behavior (product spec)

Behave like a **senior interviewer** for a system-design loop:

1. **Opening (once per Live session)**  
   After `setupComplete`, the **first** model turn should be **short**: restate the problem in one or two sentences, set expectations (“walk me through…”, “ask if you need requirements”), then **stop**.

2. **Silence by default**  
   While the candidate explains or draws, the interviewer **does not** fill dead air with constant tips. Brief thinking pauses are normal.

3. **Answer questions**  
   When the candidate **asks** something (clarification, constraint, “what would you want to see?”), the interviewer **answers** that question **only**, then stops.

4. **Feedback when appropriate**  
   Nudge or correct when there is a **clear** hook: major gap, inconsistency, scale mistake, or a natural checkpoint (e.g. after a coherent subsection). **Not** on every small edit.

5. **Feedback on request**  
   If the candidate says things like “what do you think?”, “any feedback?”, “should I go deeper on X?”, the interviewer gives **focused** feedback, then stops.

6. **Barge-in / interrupt**  
   Optional later: if the candidate talks over the model, native Live **interrupted** handling already exists on the client; keep it for natural cutoffs.

---

## 3. Solution overview (three layers)

### A. System instruction (Live `setup`)

Replace the current “always incremental feedback” stance with explicit **state machine** style rules, for example:

- **Role:** Staff/principal interviewer; calm, concise.
- **Default:** **Do not** speak unless a **trigger** below applies.
- **Triggers:**  
  - **T0 — Session start:** One short opening only (problem + how the session works).  
  - **T1 — Direct question:** The candidate’s latest turn contains a **question** (linguistic or clear request for information) → answer it briefly, then stop.  
  - **T2 — Explicit feedback request:** Phrases like “feedback”, “what do you think”, “anything I’m missing” → give **targeted** feedback, then stop.  
  - **T3 — Substantive checkpoint:** Only if the candidate has **clearly finished** a thought (see client signals below) **or** after a **long pause** in speech **and** there is a **high-value** comment (not trivia) → one short nudge.  
- **Anti-patterns:** Do not repeat back long transcripts; do not comment on every diagram tweak; do not lecture.

This text should live in **`live_bridge.py`** (same place as today), kept in sync with the URL-shortener context from `ai_module.py`.

### B. Client send policy (most important mechanically)

Stop training the model on “something changed every few hundred ms.”

**Recommended MVP:**

| Mechanism | Description |
|-----------|-------------|
| **Session opening** | After `liveReady`, send **one** synthetic `client_content` turn: e.g. `"(Session start — please give your brief opening as interviewer only; then wait.)"` so T0 is explicit. |
| **Debounce / batching** | Increase debounce for “ambient” updates (e.g. **2–4 s** after transcript/diagram stops changing) **or** only send on **sentence boundaries** / **manual “Send to interviewer”** (see below). |
| **Manual “nudge”** | A button: “Ask interviewer to respond now” → sends current transcript + diagram **once** with text like *“Please respond now (feedback or answer my last question as appropriate).”* |
| **Question / feedback heuristics (lightweight)** | Optional: if the latest transcript contains `?` or keywords (`feedback`, `what do you think`, `clarify`, …), allow a **shorter** debounce or immediate send so T1/T2 feel responsive. |

**Strong recommendation:** Do **not** send full context on a fixed **450 ms** timer tied to every keystroke or STT partial; that alone will keep the model talking.

### C. Vertex Live API configuration (optional tuning)

Review and adjust (names per current Vertex JSON schema):

- **`proactivity` / proactive audio** — Keep **off** unless product wants the model to initiate without input.
- **`realtime_input_config` / automatic activity detection** — If sending **audio** to Live later, tune end-of-speech so turns align with **natural pauses** instead of fragmenting every few hundred ms.
- **`activity_handling`** — Align with “wait for user turn” if documented for your model version.

Exact fields should be verified against the **Live API reference** for the model you use; wrong keys are ignored or cause errors.

---

## 4. Implementation checklist

1. **Done:** Live system instruction in `live_bridge.py` (T0–T3, silence default).  
2. **Done:** `App.tsx` — T0 send after `setupComplete`; debounced context (~3 s / ~0.6 s urgent); **Nudge interviewer** button.  
3. **Done:** Lightweight urgent heuristic (`?` + keywords) for shorter debounce.  
4. **QA:** Open Live → short intro → mostly silence → question → answer → “any feedback?” → feedback; use **Nudge** for explicit asks.  
5. **Done:** `README.md`, `GEMINI_LIVE_MVP.md`, and this doc cross-linked.

---

## 5. Out of scope (for later)

- Full **NLU** or server-side classifiers for “is this a question?”  
- **Ephemeral tokens** or client-direct Live (latency).  
- **Logging** model turns for analytics / replay.

---

## 6. Troubleshooting: opening repeats / never finishes

**Symptom:** The interviewer keeps repeating the first sentence or sounds stuck.

**Common causes:**

1. **New `client_content` during the opening** — Native-audio Live often **interrupts** or restarts generation when a user turn arrives mid-response. The debounced “context update” used to fire a few seconds after connect while T0 was still playing, which could restart the opening. **Mitigation (implemented):** do not send debounced context until the first server **`turn_complete`** after connect (with a 35 s fallback if that frame never arrives).

2. **Audio chunk scheduling races** — Multiple PCM chunks scheduled in parallel `.then()` callbacks could read a stale `nextStart` and overlap or stutter. **Mitigation (implemented):** serialize scheduling with an internal promise chain in `LiveAudioOut`.

3. **Caption UI looks like repetition** — If `output_audio_transcription` sends **cumulative** text instead of deltas, appending each part duplicates lines. (If you see this only in text, not in sound, inspect transcription handling.)

---

## 7. Summary

**Constant talking** is driven mainly by **sending updates too often** plus a **prompt that invites continuous commentary**. A realistic interviewer needs:

1. A **restrained** system prompt with explicit **triggers** and **silence by default**.  
2. A **client policy** that does not fire `client_content` on every delta—plus a clear **session start** and optional **manual nudge**.  
3. **Optional** Live API tuning so the stack is not biased toward proactive speech.

Implementing the checklist above (especially **B**) will move behavior much closer to a real interview without changing the overall architecture.

See **§6** for repeat/stutter issues on the opening.
