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

Run:
  pip install "livekit-agents[deepgram,anthropic,minimax,silero,turn-detector]~=1.5" python-dotenv
  python agent.py download-files     # one-time: fetch turn-detector model
  python agent.py dev                # start the worker (auto-joins new rooms)
"""

import json
import logging
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
)
from livekit.plugins import anthropic, deepgram, minimax, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

logger = logging.getLogger("voice-router")

DATA_TOPIC = "scene"  # the browser listens for commands on this topic

# Fixed confirmations — spoken straight to TTS, never composed by the LLM.
CONFIRM = {
    "generate": "generating now",
    "iterate": "on it",
    "lighting": "got it",
    "queue_world": "queuing that world",
    "retrieve": "looking that up",
}


class SceneRouter(Agent):
    """Routes spoken requests to browser scene functions via the data channel."""

    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are the voice control layer for a first-person 3D scene "
                "builder. Convert each spoken request into exactly ONE tool call. "
                "Pick the single best tool and fill its arguments from what the user "
                "said. Do NOT write any spoken reply or commentary — the tools speak "
                "their own short confirmations.\n"
                "- 'make / create / add / spawn / generate X' -> generate_object with "
                "a concise visual prompt (just the subject, e.g. 'a red ceramic mug').\n"
                "- A change to the object already in focus ('make it bigger', 'add "
                "wings', 'turn it metallic') -> iterate_object with only the change.\n"
                "- Mood / ambiance / light requests ('warmer', 'sunset', 'dim it') -> "
                "set_lighting with the description.\n"
                "If nothing matches, do nothing."
            ),
        )
        self.room = None  # set in entrypoint once we have the JobContext

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

    # Publish to the browser, then speak the fixed confirmation in parallel, then
    # stop so the LLM doesn't add its own reply.
    async def _route(self, context: RunContext, payload: dict, confirm_key: str) -> None:
        await self._publish(payload)  # visual change starts immediately
        context.session.say(CONFIRM[confirm_key], allow_interruptions=True, add_to_chat_ctx=False)
        raise StopResponse()

    # ── tools (the router) ─────────────────────────────────────────────────
    @function_tool()
    async def generate_object(self, context: RunContext, prompt: str) -> None:
        """Create a brand-new 3D object in the scene from a short visual description.
        Use for make / create / add / spawn / generate requests. The browser places
        it in front of the player. `prompt` is just the subject, e.g. 'a potted cactus'."""
        await self._route(context, {"type": "generate", "prompt": prompt}, "generate")

    @function_tool()
    async def iterate_object(self, context: RunContext, instruction: str) -> None:
        """Modify the object currently selected / looked at. Use for changes to an
        existing object ('make it bigger', 'add a handle', 'turn it red'). `instruction`
        is only the change, not the original description."""
        await self._route(context, {"type": "iterate", "instruction": instruction}, "iterate")

    @function_tool()
    async def set_lighting(self, context: RunContext, description: str) -> None:
        """Change the scene lighting / mood. Use for lighting, ambiance, time-of-day,
        or color-temperature requests ('warm sunset', 'dim and moody', 'bright studio')."""
        await self._route(context, {"type": "lighting", "description": description}, "lighting")

    # ── stubs for later wiring (worldgen + Moss retrieval) ──────────────────
    @function_tool()
    async def queue_world(self, context: RunContext, prompt: str) -> None:
        """STUB (worldgen, to be wired later): queue generation of a whole environment
        / world from a description. Publishes the command; browser handling is TODO."""
        await self._route(context, {"type": "queue_world", "prompt": prompt}, "queue_world")

    @function_tool()
    async def retrieve_object(self, context: RunContext, query: str) -> None:
        """STUB (Moss retrieval, to be wired later): find and bring in a previously
        created / stored object matching the query. Publishes the command; browser
        handling is TODO."""
        await self._route(context, {"type": "retrieve", "query": query}, "retrieve")

    # ── keep context short for speed (last few turns only) ──────────────────
    async def on_user_turn_completed(self, turn_ctx, new_message):  # noqa: ANN001
        try:
            items = turn_ctx.items[-6:]
            await self.update_chat_ctx(turn_ctx.copy(items=items))
        except Exception as e:  # never let truncation break a turn
            logger.debug("ctx truncation skipped: %s", e)


def prewarm(proc):
    """Load Silero VAD ahead of time so the first session starts warm."""
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext):
    await ctx.connect()

    session = AgentSession(
        # Streaming STT, multilingual so the semantic turn detector can work.
        stt=deepgram.STT(model="nova-3", language="multi"),
        # Fast routing LLM. Low temp + few tokens — it only emits tool calls.
        llm=anthropic.LLM(model="claude-haiku-4-5", temperature=0.2, max_tokens=128),
        # Streaming TTS for the fixed confirmations.
        tts=minimax.TTS(model="speech-2.6-turbo"),
        vad=ctx.proc.userdata["vad"],
        # Semantic, multilingual end-of-turn detection (responds when you stop,
        # not on a fixed silence timeout). Barge-in is on by default.
        turn_detection=MultilingualModel(),
    )

    agent = SceneRouter()
    agent.room = ctx.room  # tools publish via this

    await session.start(agent=agent, room=ctx.room)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
