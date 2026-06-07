# Voice layer (LiveKit Agents)

A real-time voice **router**: it listens, decides which existing browser
function to fire, and publishes a tiny JSON command over the LiveKit data
channel. It never touches three.js. The browser owns the scene and the
generate / iterate / lighting functions.

```
mic ─▶ Deepgram STT ─▶ Claude Haiku 4.5 (tool router) ─▶ data channel ─▶ browser fn
                                   └▶ fixed phrase ─▶ Minimax TTS ─▶ your speakers
```

## Pipeline

- **STT** Deepgram streaming (`nova-3`, multilingual)
- **LLM** Anthropic `claude-haiku-4-5` — picks one tool and fills args only
- **TTS** Minimax streaming (`speech-2.6-turbo`)
- **VAD** Silero (prewarmed)
- **Turn detection** LiveKit semantic multilingual model
- **Barge-in** on (interrupt any time)

**Latency:** each tool publishes the data command to the browser *first*, then
speaks a fixed confirmation ("generating now", "on it", "got it") straight to
TTS — the LLM never composes the spoken reply, and the visual change starts
before the audio finishes.

## Tools (the router)

| Tool | Publishes | Browser does |
|---|---|---|
| `generate_object(prompt)` | `{type:"generate", prompt}` | generates, placed in front of the player |
| `iterate_object(instruction)` | `{type:"iterate", instruction}` | applies to the selected / looked-at object |
| `set_lighting(description)` | `{type:"lighting", description}` | runs the lighting layer |
| `queue_world(prompt)` | `{type:"queue_world", prompt}` | **stub** (worldgen, later) |
| `retrieve_object(query)` | `{type:"retrieve", query}` | **stub** (Moss, later) |

## Setup

Use Python **3.11+** (the system 3.9 may be too old for some plugin wheels):

```bash
cd voice
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python agent.py download-files     # one-time: turn-detector model
```

Keys are read from the project-root `../.env` (shared with the Node proxy):
`ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `MINIMAX_API_KEY`,
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

Get LiveKit creds free at https://cloud.livekit.io (project → Settings →
Keys; URL looks like `wss://<project>.livekit.cloud`). Deepgram:
https://console.deepgram.com · Minimax: https://www.minimax.io.

## Run

```bash
# 1) the app (from repo root)
npm run dev:all                    # web :5173 + proxy :8787

# 2) the voice worker (from voice/, venv active)
python agent.py dev
```

The worker has **no `agent_name`**, so LiveKit auto-dispatches it to any room
the browser joins. Open http://localhost:5173, click **Voice** (or press `V`),
allow the mic, and talk: *"make a red mushroom"*, *"make it bigger"*,
*"warm sunset lighting"*. The browser and worker share the room name
`VOICE_ROOM` (default `studio`).

## Verify each leg in isolation

1. **mic → transcript** — `python agent.py dev` logs Deepgram transcripts as you speak.
2. **transcript → tool call** — the worker logs the selected tool + args.
3. **tool → data → browser fn** — browser console shows the received command and the scene reacts (toast + placeholder).
4. **confirmation → audio** — you hear the short fixed phrase; the visual starts first.

Token sanity check (proxy must have LiveKit creds):
```bash
curl 'http://localhost:8787/api/voice-token'    # -> { url, token, room }
```
