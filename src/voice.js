// LiveKit voice client. Connects the browser to the same room as the Python
// voice worker, publishes the mic, plays the agent's TTS, and turns inbound
// data-channel commands into calls on the scene functions.
//
// The agent never touches three.js — it only publishes JSON like
//   { type: "generate", prompt }      { type: "iterate", instruction }
//   { type: "lighting", description } { type: "queue_world" | "retrieve", ... }
// which we hand to onCommand(msg).

import { Room, RoomEvent, Track } from 'livekit-client';

export function createVoice({ onCommand, onState, worldState }) {
  let room = null;

  const emit = (patch) => onState && onState(patch);

  async function connect() {
    // Mint a dev token from our proxy (never ships the LiveKit secret).
    // Use a FRESH room name every time voice is toggled on. The agent worker
    // dispatches a brand-new job per room, so each connection gets its own agent
    // bound to the current participant — toggling off→on (or a page reload) can
    // never land on a stale session that's deaf to the new participant.
    // Tag the name "built" once a world exists so the agent skips the "what
    // world would you like to build?" greeting on reconnects after a world exists.
    const built = typeof worldState === 'function' && worldState();
    const roomName = `studio-${built ? 'built-' : ''}${Date.now().toString(36)}`;
    const res = await fetch(`/api/voice-token?room=${encodeURIComponent(roomName)}`);
    if (!res.ok) {
      let msg = 'voice token request failed';
      try { msg = (await res.json()).error || msg; } catch { /* noop */ }
      throw new Error(msg);
    }
    const { url, token } = await res.json();

    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Suppress the agent's own TTS / room audio from re-entering the mic,
      // which otherwise creates phantom turns that re-trigger generation.
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // Play the agent's TTS the instant its audio track arrives.
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.autoplay = true;
        el.style.display = 'none';
        document.body.appendChild(el);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
    });

    // Inbound scene commands from the agent.
    room.on(RoomEvent.DataReceived, (payload) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        onCommand && onCommand(msg);
      } catch (e) {
        console.warn('[voice] bad data message', e);
      }
    });

    // Speaking indicators (agent = any non-local speaker; you = local).
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      emit({
        agentSpeaking: speakers.some((p) => !p.isLocal),
        userSpeaking: speakers.some((p) => p.isLocal),
      });
    });

    room.on(RoomEvent.Disconnected, () => {
      room = null;
      emit({ connected: false, agentSpeaking: false, userSpeaking: false });
    });

    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    // connect() runs inside the toggle click, so this gesture satisfies autoplay.
    try { await room.startAudio(); } catch { /* noop */ }

    emit({ connected: true });
  }

  async function disconnect() {
    if (room) { await room.disconnect(); room = null; }
    emit({ connected: false, agentSpeaking: false, userSpeaking: false });
  }

  // Outbound message to the agent (same `scene` topic). Used to tell the agent a
  // preview image is on screen so it can ask the user for approval by voice.
  async function send(payload) {
    if (!room) return false;
    try {
      await room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify(payload)),
        { reliable: true, topic: 'scene' },
      );
      return true;
    } catch (e) {
      console.warn('[voice] send failed', e);
      return false;
    }
  }

  return {
    connect,
    disconnect,
    send,
    isConnected: () => !!room,
    async toggle() {
      if (this.isConnected()) await disconnect();
      else await connect();
    },
  };
}
