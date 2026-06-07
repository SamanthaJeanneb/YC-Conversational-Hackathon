"""
Real-time voice control layer for the 3D scene builder.

This worker is ONLY a router. It listens, decides which existing browser
function to trigger, and publishes a tiny JSON command over the LiveKit data
channel. The browser owns the three.js scene and the generate / iterate /
lighting functions — this file never touches three.js.

Latency design (see LATENCY REQUIREMENTS):
  - STT / LLM / TTS all stream.
  - The LLM ONLY picks a tool and fills args. It never composes the spoken
    reply. Each tool speaks a fixed short confirmation via session.say(), so
    there's no second LLM round-trip for wording.
  - Optimistic parallel execution: the data message is published to the
    browser the instant the tool fires (awaited first), THEN the confirmation
    is spoken — so the visual change begins before the audio finishes.
  - Semantic multilingual turn detector → responds the moment you stop talking.
  - Barge-in / interruptions are on by default.

STT, LLM, and TTS all route through LiveKit Inference (no provider keys/plugins
— a single bill on your LiveKit credit). The only credentials needed are
LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET. VAD (Silero) and the turn
detector are local plugins that need no keys.

Run:
  pip install "livekit-agents[silero,turn-detector]~=1.5" python-dotenv
  python agent.py download-files     # one-time: fetch VAD + turn-detector models
  python agent.py dev                # start the worker (auto-joins new rooms)
"""

import json
import logging
import time
from pathlib import Path

from dotenv import load_dotenv

# Load the shared project .env (LIVEKIT_*, DEEPGRAM_API_KEY, ANTHROPIC_API_KEY,
# MINIMAX_API_KEY) first, then any voice/.env override.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv()

from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    StopResponse,
    WorkerOptions,
    cli,
    function_tool,
    inference,  # LiveKit Inference gateway — STT/LLM/TTS on LiveKit creds only
)
from livekit.plugins import silero  # local VAD (no API key)
from livekit.plugins.turn_detector.multilingual import MultilingualModel  # local turn detector

logger = logging.getLogger("voice-router")

DATA_TOPIC = "scene"  # the browser listens for commands on this topic

# Confirmations are short and SPECIFIC — they echo what the user asked for so
# they know exactly what's happening, but they're built by templating (no second
# LLM round-trip, so no added latency). Clarifying questions are the one case
# where the model composes its own words.
def _trim(text: str, limit: int = 60) -> str:
    """Keep spoken confirmations short — echo the subject, not an essay."""
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


# Filler the model often wraps a lighting request in. Stripped so the spoken
# confirmation reads cleanly — "Setting warm lighting", not "Setting the
# lighting lighting warm".
_LIGHT_PREFIXES = (
    "make the lighting", "set the lighting", "change the lighting",
    "turn the lighting", "make the lights", "turn the lights",
    "make it", "set it", "change it", "turn it",
    "the lighting", "lighting", "the lights", "lights",
    "everything", "make", "set", "change", "turn", "to",
)


def _light_confirm(description: str) -> str:
    """Turn a free-form lighting description into a clean spoken confirmation."""
    d = " ".join(description.split()).rstrip(".")
    low = d.lower()
    if any(w in low for w in ("reset", "default", "original", "back to normal")):
        return "Resetting the lighting."
    # Peel off any leading filler phrases (repeatedly, e.g. "make the lighting to warm").
    changed = True
    while changed and d:
        changed = False
        for p in _LIGHT_PREFIXES:
            if low == p or low.startswith(p + " "):
                d, low, changed = d[len(p):].strip(), d[len(p):].strip().lower(), True
                break
    # Drop a trailing "lighting"/"lights" so we don't double it when we re-add it.
    for suf in (" lighting", " lights"):
        if low.endswith(suf):
            d = d[: -len(suf)].strip()
    return f"Setting {d} lighting." if d else "Updating the lighting."


class SceneRouter(Agent):
    """Routes spoken requests to browser scene functions via the data channel."""

    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are the voice control layer for a first-person 3D scene "
                "builder. Convert each spoken request into exactly ONE tool call. "
                "Pick the single best tool and fill its arguments from what the user "
                "said. Do NOT free-narrate — the action tools speak their own short "
                "confirmation, and the one time you choose your own words is ask_clarify.\n"
                "- A request for a WHOLE WORLD / environment / level / scene / place / "
                "landscape you walk around inside ('build a dungeon crossroads with a "
                "stream', 'a forest clearing', 'a sci-fi hangar', 'make me a desert') -> "
                "queue_world with the FULL description in the user's words. A world is the "
                "surroundings, NOT a single prop. At the start of the session the user is "
                "in an empty flat room and you've asked what world to build, so their first "
                "answer is almost always a world -> queue_world. When torn between a world "
                "and an object, ask: would you walk around inside it? If yes -> queue_world.\n"
                "- 'make / create / add / spawn / generate X' (a single object/prop) -> "
                "generate_object with a concise visual prompt (just the subject, e.g. 'a "
                "red ceramic mug').\n"
                "- A change to the object already in focus ('make it bigger', 'add "
                "wings', 'turn it metallic') -> iterate_object with only the change.\n"
                "APPROVAL GATE (iterate only): after an iterate_object call the app "
                "shows a PREVIEW image and you ask the user 'want me to build it?'. On "
                "that follow-up turn ONLY: 'yes / build it / go ahead / do it / looks "
                "good / perfect / yeah' -> approve_build; 'no / cancel / scrap it / "
                "never mind' -> cancel_build; but if they ask for a FURTHER change "
                "('make it bluer', 'bigger') -> iterate_object again (it refines the "
                "same preview). Never call approve_build / cancel_build at any other time.\n"
                "- Mood / ambiance / light requests -> set_lighting with the description. "
                "ANY request about the scene's light, brightness, color, atmosphere, "
                "time of day, or mood goes here — pass the user's own words as the "
                "description so the scene can interpret them freely. This includes any "
                "color ('make it red', 'very yellow', 'deep blue'), named scenes or vibes "
                "('underwater', 'nightclub', 'candlelit', 'horror', 'sunset on mars'), "
                "relative tweaks ('warmer', 'cooler', 'dimmer', 'brighter'), AND resets "
                "('reset the lighting', 'default lighting', 'back to normal' — pass these "
                "through verbatim). The words 'lighting' / 'light' / 'warmer' / 'dimmer' / "
                "'reset' ALWAYS mean set_lighting, even when phrased as 'make the lighting "
                "…' — never route those to iterate_object.\n"
                "CLARIFY when underspecified: if the user names a bare object with no "
                "material, style, color, or other distinguishing detail (just 'a chair', "
                "'a table', 'a car'), call ask_clarify ONCE with a brief question naming "
                "the 1-2 most useful dimensions to pin down (e.g. 'What kind of chair — "
                "and what material?'). The moment the user adds ANY detail, stop asking "
                "and call generate_object. Ask at most one clarifying question per object; "
                "if they decline or stay vague, just generate something reasonable.\n"
                "Call exactly ONE tool per request. Each spoken request is INDEPENDENT: "
                "if the user changes something you just set — lighting yellow then 'make "
                "it red', 'bigger' then 'smaller', one object then another — that is a "
                "NEW request and you MUST run the tool again, even if it's the same tool "
                "you used last turn and even if it appears in the history above. Changing "
                "a value to a different value is never a repeat. Only call NO tool and "
                "stay silent when there is genuinely no new request: silence, filler, or "
                "the exact words of your own confirmation echoing back."
            ),
        )
        self.room = None  # set in entrypoint once we have the JobContext
        # Guard against speaking the same line twice in quick succession (mic
        # echo of our own TTS, turn splitting, or overlapping triggers can fire
        # the same say twice). Every spoken line goes through _say().
        self._last_say_text = ""
        self._last_say_t = 0.0

    # ── speak once (dedupe identical back-to-back lines) ─────────────────────
    def _say(self, session, text: str, *, add_to_chat_ctx: bool = False, limit: int = 60) -> None:
        text = _trim(text, limit)
        now = time.monotonic()
        if text == self._last_say_text and now - self._last_say_t < 8.0:
            logger.info("suppressed duplicate say: %s", text)
            return
        self._last_say_text = text
        self._last_say_t = now
        session.say(text, allow_interruptions=True, add_to_chat_ctx=add_to_chat_ctx)

    # ── data-channel helper ────────────────────────────────────────────────
    async def _publish(self, payload: dict) -> None:
        if self.room is None:
            logger.warning("no room; dropping %s", payload)
            return
        await self.room.local_participant.publish_data(
            json.dumps(payload).encode("utf-8"),
            reliable=True,
            topic=DATA_TOPIC,
        )

    # Publish to the browser, then speak the confirmation in parallel, then stop
    # so the LLM doesn't add its own reply. `confirm` already echoes the request.
    async def _route(self, context: RunContext, payload: dict, confirm: str) -> None:
        await self._publish(payload)  # visual change starts immediately
        self._say(context.session, confirm)  # spoken once (dedupes echo repeats)
        raise StopResponse()

    # ── tools (the router) ─────────────────────────────────────────────────
    @function_tool()
    async def generate_object(self, context: RunContext, prompt: str) -> None:
        """Create a brand-new 3D object in the scene from a short visual description.
        Use for make / create / add / spawn / generate requests. The browser places
        it in front of the player. `prompt` is just the subject, e.g. 'a potted cactus'."""
        await self._route(context, {"type": "generate", "prompt": prompt}, f"Making {prompt}.")

    @function_tool()
    async def iterate_object(self, context: RunContext, instruction: str) -> None:
        """Modify the object currently selected / looked at. Use for changes to an
        existing object ('make it bigger', 'add a handle', 'turn it red'). `instruction`
        is only the change, not the original description. The browser generates a
        PREVIEW image first; once it's on screen you'll ask the user to approve before
        the model is rebuilt (see approve_build / cancel_build)."""
        await self._route(context, {"type": "iterate", "instruction": instruction}, "One moment — previewing that.")

    @function_tool()
    async def approve_build(self, context: RunContext) -> None:
        """Approve the previewed change and build the 3D model. Use ONLY right after you
        asked 'want me to build it?' and the user agrees ('yes', 'build it', 'go ahead',
        'do it', 'looks good', 'perfect', 'yeah'). If they instead ask for another change,
        call iterate_object; if they decline, call cancel_build."""
        await self._route(context, {"type": "approve_build"}, "Building it now.")

    @function_tool()
    async def cancel_build(self, context: RunContext) -> None:
        """Discard the previewed change without building. Use ONLY right after you asked
        'want me to build it?' and the user declines ('no', 'cancel', 'scrap it', 'never
        mind', 'start over')."""
        await self._route(context, {"type": "cancel_build"}, "Okay, scrapped that.")

    @function_tool()
    async def set_lighting(self, context: RunContext, description: str) -> None:
        """Change the scene lighting / mood / atmosphere to ANYTHING the user describes:
        any color ('red', 'very yellow'), named scene ('underwater', 'nightclub',
        'candlelit'), time of day ('sunset', 'midnight'), relative tweak ('warmer',
        'dimmer'), or a reset ('reset', 'default lighting', 'back to normal' — pass those
        words through). `description` is the user's own words, verbatim."""
        await self._route(context, {"type": "lighting", "description": description}, _light_confirm(description))

    @function_tool()
    async def ask_clarify(self, context: RunContext, question: str) -> None:
        """Ask ONE short follow-up when a request is too vague to build well — e.g. the
        user named a bare object with no material/style/color ('a chair' -> 'What kind of
        chair, and what material?'). Speaks `question` and waits; publishes nothing. Use
        sparingly: only when a detail genuinely changes the result, never more than once
        per object. `question` must be a single concise spoken question."""
        # Spoken in the model's own words; kept in context so it knows it already
        # asked and can merge the user's answer with the original request.
        self._say(context.session, question, add_to_chat_ctx=True, limit=100)
        raise StopResponse()

    # ── worldgen: build a whole environment from a spoken description ────────
    @function_tool()
    async def queue_world(self, context: RunContext, prompt: str) -> None:
        """Build a whole WORLD / environment / level the user walks around inside, from a
        spoken description ('a dungeon crossroads with a stream', 'a forest clearing').
        The browser generates a preview image, shows it for approval, and on approval
        loads the environment and drops the player inside. `prompt` is the user's full
        world description in their own words."""
        await self._route(
            context,
            {"type": "queue_world", "prompt": prompt},
            "Here's a preview — approve it to build your world.",
        )

    # ── stub for later wiring (Moss retrieval) ──────────────────────────────

    @function_tool()
    async def retrieve_object(self, context: RunContext, query: str) -> None:
        """STUB (Moss retrieval, to be wired later): find and bring in a previously
        created / stored object matching the query. Publishes the command; browser
        handling is TODO."""
        await self._route(context, {"type": "retrieve", "query": query}, f"Looking up {query}.")

    # ── keep context short for speed (last few turns only) ──────────────────
    async def on_user_turn_completed(self, turn_ctx, new_message):  # noqa: ANN001
        # Keep history short for speed, but enough that a clarify question and the
        # user's answer survive together (so 'a chair' + 'wooden, dining' merge into
        # one generate). Action confirmations aren't added to ctx, so this won't
        # make the model re-issue a past generation on echo turns.
        try:
            await self.update_chat_ctx(turn_ctx.truncate(max_items=4))
        except Exception as e:  # never let truncation break a turn
            logger.debug("ctx truncation skipped: %s", e)


def prewarm(proc):
    """Load Silero VAD ahead of time so the first session starts warm."""
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext):
    await ctx.connect()

    # Everything routes through LiveKit Inference — one bill on your LiveKit
    # credit, no provider keys/plugins. (Claude isn't in the Inference catalog,
    # so the router LLM is gpt-4.1-mini: fast and strong at tool calling.)
    session = AgentSession(
        # Streaming STT, multilingual so the semantic turn detector can work.
        stt=inference.STT(model="deepgram/nova-3", language="multi"),
        # Fastest capable catalog model for intent parsing / tool routing.
        llm=inference.LLM(model="openai/gpt-4.1-mini"),
        # Lowest-latency streaming TTS, natural English voice (Cartesia "Jacqueline").
        tts=inference.TTS(model="cartesia/sonic-2", voice="9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"),
        vad=ctx.proc.userdata["vad"],
        # Semantic, multilingual end-of-turn detection (responds when you stop,
        # not on a fixed silence timeout). Barge-in is on by default.
        turn_detection=MultilingualModel(),
        # One tool call per turn — never chain or repeat within a turn.
        max_tool_steps=1,
    )

    agent = SceneRouter()
    agent.room = ctx.room  # tools publish via this

    # When the browser finishes an iterate PREVIEW image and shows it, it sends us
    # a `preview_ready` over the same data topic. We ask for approval ONLY now —
    # so the spoken "want me to build it?" lands after the image is on screen, not
    # before. Kept in chat ctx so the model knows it asked and can route the user's
    # yes/no to approve_build / cancel_build.
    @ctx.room.on("data_received")
    def _on_browser_data(packet) -> None:  # noqa: ANN001
        if getattr(packet, "topic", None) != DATA_TOPIC:
            return
        try:
            msg = json.loads(bytes(packet.data).decode("utf-8"))
        except Exception:
            return
        if msg.get("type") == "preview_ready":
            subject = msg.get("subject") or "the change"
            agent._say(session, f"Here's {subject}. Want me to build it?", add_to_chat_ctx=True, limit=100)

    # Default close_on_disconnect=True: when the participant leaves (toggle off /
    # reload), close the session so this job ends and the room is recycled. The
    # browser opens a FRESH room on every connect, so each toggle-on gets a new
    # job bound to the current participant — no stale, deaf sessions. (Brief
    # network blips don't drop the participant; LiveKit resumes them transparently.)
    await session.start(agent=agent, room=ctx.room)

    # Greet ONLY when the player is still in the empty flat world. The browser
    # tags the room name "built" once a world exists, so re-toggling voice after
    # a world is loaded never re-asks "what world would you like to build?".
    # On a fresh page (flat world again) the tag is absent and we greet normally.
    if "built" not in ctx.room.name:
        agent._say(session, "Hi! What kind of world would you like to build?")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
