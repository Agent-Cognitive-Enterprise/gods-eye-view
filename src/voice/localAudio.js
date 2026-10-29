// Microphone capture and playback for local voice (fork feature). Audio stays
// in this browser until it is posted to this machine's own server. Open-mic
// segmentation is a simple energy detector with an adaptive noise floor (no
// model); push-to-talk segments are explicit. Segments become 16 kHz mono
// 16-bit WAV, the format the local speech-to-text expects.

export const TARGET_RATE = 16_000;
const MAX_SEGMENT_MS = 15_000;
const PREROLL_MS = 300;
const START_MS = 120;
// Tolerant enough for a brief audio dropout under heavy CPU load.
const END_SILENCE_MS = 1100;
const MIN_SPEECH_MS = 300;

/** Linear resampling to 16 kHz and 16-bit PCM WAV bytes. */
export function encodeWav16k(samples, sampleRate) {
  const ratio = sampleRate / TARGET_RATE;
  const length = Math.max(0, Math.floor(samples.length / ratio));
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const value =
      samples[left] + (samples[right] - samples[left]) * (position - left);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(new Uint8Array(pcm.buffer), 44);
  return bytes;
}

/** Level of one frame in dBFS. */
export function frameDb(frame) {
  let sum = 0;
  for (const value of frame) sum += value * value;
  return 10 * Math.log10(sum / Math.max(1, frame.length) + 1e-12);
}

/**
 * Energy voice-activity detector over successive frames. Pure: feed frames,
 * receive 'start' / 'end' / null. Speech must exceed the adaptive noise floor
 * by `marginDb` for START_MS; it ends after END_SILENCE_MS below it.
 */
export function createEnergyVad({ frameMs, marginDb = 12, minDb = -50 }) {
  let floor = -60;
  let above = 0;
  let below = 0;
  let speaking = false;
  let spoken = 0;
  return {
    get speaking() {
      return speaking;
    },
    reset() {
      above = 0;
      below = 0;
      speaking = false;
      spoken = 0;
    },
    push(db) {
      const threshold = Math.max(minDb, floor + marginDb);
      const loud = db > threshold;
      if (!speaking && !loud) floor = floor * 0.95 + db * 0.05; // track quiet rooms
      if (!speaking) {
        above = loud ? above + frameMs : 0;
        if (above >= START_MS) {
          speaking = true;
          spoken = above;
          below = 0;
          return 'start';
        }
        return null;
      }
      spoken += frameMs;
      below = loud ? 0 : below + frameMs;
      if (below >= END_SILENCE_MS || spoken >= MAX_SEGMENT_MS) {
        const long = spoken - below >= MIN_SPEECH_MS;
        speaking = false;
        above = 0;
        below = 0;
        return long ? 'end' : 'discard';
      }
      return null;
    },
  };
}

/**
 * Microphone capture with open-mic segmentation or explicit push-to-talk.
 * @param {{onSegment: (wav: Uint8Array) => void, onSpeechStart?: Function,
 *   onLevel?: (db: number) => void, getUserMedia?: Function,
 *   AudioContextClass?: Function}} options
 */
export function createMicCapture({
  onSegment,
  onSpeechStart = () => {},
  onLevel = () => {},
  getUserMedia = (constraints) =>
    globalThis.navigator?.mediaDevices?.getUserMedia(constraints),
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeClass = globalThis.AudioWorkletNode,
}) {
  let stream = null;
  let context = null;
  let processor = null;
  let source = null;
  let sink = null;
  let openMic = true;
  let paused = false;
  let manual = false;
  let collected = [];
  let preroll = [];
  let vad = null;
  let rate = 48_000;

  const flush = () => {
    const total = collected.reduce((n, frame) => n + frame.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const frame of collected) {
      samples.set(frame, offset);
      offset += frame.length;
    }
    collected = [];
    if (total > rate * 0.25) onSegment(encodeWav16k(samples, rate));
  };

  const onFrame = (frame) => {
    const db = frameDb(frame);
    onLevel(db);
    if (manual) {
      collected.push(frame);
      if (collected.length * frame.length > (rate * MAX_SEGMENT_MS) / 1000) {
        manual = false;
        flush();
      }
      return;
    }
    if (!openMic || paused) return;
    const keep = Math.ceil(((PREROLL_MS / 1000) * rate) / frame.length);
    const edge = vad.push(db);
    if (vad.speaking || edge === 'end' || edge === 'discard')
      collected.push(frame);
    else {
      preroll.push(frame);
      if (preroll.length > keep) preroll.shift();
    }
    if (edge === 'start') {
      collected = [...preroll, frame];
      preroll = [];
      onSpeechStart();
    } else if (edge === 'end') flush();
    else if (edge === 'discard') collected = [];
  };

  return {
    async start({ pushToTalk = false } = {}) {
      if (!AudioContextClass) throw new Error('no_audio');
      openMic = !pushToTalk;
      stream = await getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      context = new AudioContextClass();
      await context.resume?.();
      source = context.createMediaStreamSource(stream);
      // A silent sink keeps the capture node running without echoing the mic.
      sink = context.createGain();
      sink.gain.value = 0;
      if (context.audioWorklet && AudioWorkletNodeClass) {
        // The app's existing capture worklet: resamples to 16 kHz PCM on the
        // audio thread, so a busy page cannot drop or garble speech.
        await context.audioWorklet.addModule(
          new URL('./geminiCaptureWorklet.js', import.meta.url),
        );
        processor = new AudioWorkletNodeClass(context, 'gev-gemini-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        rate = TARGET_RATE;
        vad = createEnergyVad({ frameMs: (1024 / TARGET_RATE) * 1000 });
        processor.port.onmessage = ({ data }) => {
          if (data?.type !== 'audio' || !(data.buffer instanceof ArrayBuffer))
            return;
          const pcm = new Int16Array(data.buffer);
          const frame = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) frame[i] = pcm[i] / 32768;
          onFrame(frame);
        };
        processor.port.postMessage({ enabled: true, captureId: 1 });
      } else {
        rate = context.sampleRate;
        processor = context.createScriptProcessor(2048, 1, 1);
        vad = createEnergyVad({ frameMs: (2048 / rate) * 1000 });
        processor.onaudioprocess = (event) =>
          onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
      }
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
    },
    /** Ignore open-mic speech (e.g. while our own reply plays). */
    setPaused(value) {
      paused = Boolean(value);
      if (paused) {
        vad?.reset();
        collected = [];
      }
    },
    beginManual() {
      if (!processor) return false;
      vad?.reset();
      collected = [];
      manual = true;
      return true;
    },
    endManual() {
      if (!manual) return;
      manual = false;
      flush();
    },
    stop() {
      manual = false;
      collected = [];
      preroll = [];
      try {
        processor?.disconnect();
        source?.disconnect();
        sink?.disconnect();
      } catch {
        /* already disconnected */
      }
      if (processor) {
        processor.onaudioprocess = null;
        if (processor.port) processor.port.onmessage = null;
      }
      for (const track of stream?.getTracks?.() ?? []) track.stop();
      void context?.close?.().catch(() => {});
      stream = context = processor = source = sink = null;
    },
    get active() {
      return Boolean(stream);
    },
  };
}

/** Play WAV bytes; resolves when finished or stopped. One utterance at a time. */
export function createSpeechPlayer({
  AudioClass = globalThis.Audio,
  URLImpl = globalThis.URL,
} = {}) {
  let current = null;
  return {
    play(bytes) {
      this.stop();
      const url = URLImpl.createObjectURL(
        new Blob([bytes], { type: 'audio/wav' }),
      );
      const audio = new AudioClass(url);
      const done = new Promise((resolve) => {
        const finish = (completed) => {
          URLImpl.revokeObjectURL(url);
          if (current?.audio === audio) current = null;
          resolve(completed);
        };
        audio.addEventListener('ended', () => finish(true), { once: true });
        audio.addEventListener('error', () => finish(false), { once: true });
        current = { audio, finish };
      });
      audio.play().catch(() => current?.finish(false));
      return done;
    },
    stop() {
      if (!current) return;
      const { audio, finish } = current;
      audio.pause();
      finish(false);
    },
    get playing() {
      return Boolean(current);
    },
  };
}
