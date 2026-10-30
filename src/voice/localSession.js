// Local voice session adapter (fork feature): microphone → this machine's
// speech-to-text → local model → validated calls through the existing action
// runner (or the Autopilot console) → spoken reply from local text-to-speech.
// Implements the common adapter contract (start, stop, sendText,
// sendMapEvent) and emits the provider-neutral session events, so the voice
// card, panel and status work as for the cloud providers. No audio, text or
// prompt leaves this machine: every request goes to the same-origin server,
// which talks only to loopback services. Click starts open-mic; holding Space
// for 500 ms talks while held and interrupts a reply that is playing.

import { shouldHandlePushToTalkKeyDown } from './realtimeInputPolicy.js';
import { t } from '../i18n/index.js';
import { createMicCapture, createSpeechPlayer } from './localAudio.js';
import { AUTOPILOT_TOOL_NAMES } from './localProtocol.js';

const BASE = '/api/voice-local';
const HOLD_MS = 500;

/** Cyrillic text is treated as Russian; everything else as English. */
export function guessLanguage(text) {
  return /[Ѐ-ӿ]/.test(String(text)) ? 'ru' : 'en';
}

/**
 * @param {{emit: Function, runAction: Function, signal: AbortSignal,
 *   fetchImpl?: Function, documentRef?: Document, createCapture?: Function,
 *   player?: object, autopilot?: () => object|null,
 *   readContext?: () => object}} options
 */
export function createLocalSession({
  emit,
  runAction,
  signal,
  fetchImpl = (...args) => globalThis.fetch(...args),
  documentRef = globalThis.document,
  createCapture = createMicCapture,
  player = createSpeechPlayer(),
  autopilot = () => globalThis.__gevIntel ?? null,
  readContext = () => ({}),
}) {
  let capture = null;
  let active = false;
  let pushToTalk = false;
  let turn = 0;
  let turnAbort = null;
  let holdTimer = null;
  let spaceHeld = false;

  const call = async (
    path,
    { body, type = 'application/json', signal: s } = {},
  ) => {
    const response = await fetchImpl(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': type },
      body:
        body === undefined
          ? undefined
          : type === 'application/json'
            ? JSON.stringify(body)
            : body,
      signal: s,
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  };

  const listening = () =>
    emit({
      type: 'state',
      state: 'listening',
      detail: pushToTalk
        ? t('Local voice · hold Space to talk')
        : t('Local voice · listening'),
    });

  /** Speak `text` in `lang`; resolves false when interrupted. */
  async function speak(text, lang, abort) {
    if (!text) return true;
    try {
      const response = await call('/speak', {
        body: { text, lang },
        signal: abort,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (abort.aborted) return false;
      capture?.setPaused(true); // do not hear ourselves
      emit({ type: 'state', state: 'executing', detail: t('Speaking') });
      return await player.play(bytes);
    } catch {
      return false;
    } finally {
      capture?.setPaused(false);
    }
  }

  async function runAutopilotTool(name, args) {
    const console_ = autopilot();
    if (!console_)
      return { ok: false, text: t('Autopilot is not available here') };
    if (name === 'find_events') return console_.findEvents(args);
    return console_.voiceControl(args.action);
  }

  /** One spoken or typed command, start to finish. Newer input supersedes it. */
  async function runTurn(text, language, id = ++turn) {
    turnAbort?.abort();
    turnAbort = new AbortController();
    const abort = AbortSignal.any([turnAbort.signal, signal]);
    player.stop();
    const current = () => id === turn && !abort.aborted;
    emit({ type: 'state', state: 'executing', detail: t('Thinking') });
    let reply = '';
    let lang = language;
    try {
      const response = await call('/turn', {
        body: { text, language, context: readContext() },
        signal: abort,
      });
      const result = await response.json();
      if (!current()) return;
      if (!result.ok) reply = t('Sorry, I could not understand that command.');
      else {
        lang = result.turn.language;
        reply = result.turn.reply;
        const notes = [];
        let index = 0;
        for (const item of result.turn.calls) {
          if (!current()) return;
          const callId = `local-${id}-${index++}`;
          if (AUTOPILOT_TOOL_NAMES.has(item.name)) {
            const outcome = await runAutopilotTool(item.name, item.arguments);
            if (outcome?.text) notes.push(outcome.text);
            continue;
          }
          try {
            const outcome = await runAction(item.name, item.arguments, {
              callId,
              signal: abort,
            });
            if (outcome && outcome.ok === false)
              notes.push(
                t('That did not work: {reason}', {
                  reason: String(outcome.error ?? '').slice(0, 120),
                }),
              );
          } catch (error) {
            if (!current()) return;
            notes.push(
              t('That did not work: {reason}', {
                reason: String(error?.message ?? '').slice(0, 120),
              }),
            );
          }
        }
        // Facts the console produced (explanations, findings) replace a
        // generic acknowledgement; failures are always said.
        if (notes.length) reply = [reply, ...notes].filter(Boolean).join(' ');
      }
    } catch (error) {
      if (!current()) return;
      reply =
        error?.status === 403
          ? t('Local voice works only on the host computer.')
          : t('The local model is not responding.');
    }
    if (!current()) return;
    emit({
      type: 'transcript',
      role: 'assistant',
      text: reply,
      final: true,
      responseId: `local-${id}`,
    });
    const spoken = await speak(reply, lang, abort);
    const finished = current();
    // Every reply ends with a completion, also one cut off by newer input.
    emit({
      type: 'completion',
      status: spoken && finished ? 'completed' : 'interrupted',
      responseId: `local-${id}`,
      spoken,
    });
    if (finished && active) listening();
  }

  async function onSegment(wav) {
    if (!active) return;
    const id = ++turn; // a new utterance supersedes whatever was running
    turnAbort?.abort();
    interrupt(); // and silences a reply that is still playing
    emit({ type: 'state', state: 'executing', detail: t('Transcribing') });
    try {
      const response = await call('/transcribe', {
        body: wav,
        type: 'audio/wav',
        signal,
      });
      const { text, language } = await response.json();
      if (id !== turn || !active) return;
      if (!text) {
        listening();
        return;
      }
      emit({ type: 'transcript', role: 'user', text, final: true });
      await runTurn(text, language ?? guessLanguage(text), id);
    } catch {
      if (id === turn && active) {
        emit({
          type: 'state',
          state: 'listening',
          detail: t('Speech-to-text is not responding'),
        });
      }
    }
  }

  const interrupt = () => {
    if (!player.playing) return;
    player.stop();
    emit({ type: 'interruption', reason: 'user-speech' });
  };

  const onKeyDown = (event) => {
    // The app's own push-to-talk policy: Space only, no modifiers, never
    // in text entry (inputs, ARIA text widgets and their descendants).
    if (event.repeat || !shouldHandlePushToTalkKeyDown(event) || !active)
      return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!capture?.beginManual()) return;
      spaceHeld = true;
      interrupt();
      emit({
        type: 'state',
        state: 'listening',
        detail: t('Talk now · release Space to send'),
      });
    }, HOLD_MS);
  };
  const onKeyUp = (event) => {
    if (event.code !== 'Space') return;
    clearTimeout(holdTimer);
    if (!spaceHeld) return;
    spaceHeld = false;
    event.preventDefault();
    capture?.endManual();
  };

  function unbindKeys() {
    documentRef?.removeEventListener('keydown', onKeyDown, true);
    documentRef?.removeEventListener('keyup', onKeyUp, true);
  }

  return {
    capabilities: { costControls: false, pushToTalk: true },
    async start(options = {}) {
      pushToTalk = Boolean(options.pushToTalk);
      const status = await (await call('/status', { signal })).json();
      if (!status?.enabled)
        throw new Error(t('Local voice is not set up on this computer.'));
      if (!status.stt?.available)
        throw new Error(t('Local speech-to-text is not running.'));
      if (status.llm?.state !== 'online')
        throw new Error(t('The local model is offline.'));
      capture = createCapture({
        onSegment: (wav) => void onSegment(wav),
        onSpeechStart: interrupt,
      });
      try {
        await capture.start({ pushToTalk });
      } catch {
        capture = null;
        throw new Error(
          t(
            'Microphone unavailable. Local voice needs microphone access on this computer.',
          ),
        );
      }
      active = true;
      void call('/session', { body: { active: true } }).catch(() => {});
      listening();
    },
    getStartOptions: () => ({ pushToTalk }),
    stop() {
      active = false;
      turn += 1;
      turnAbort?.abort();
      clearTimeout(holdTimer);
      spaceHeld = false;
      player.stop();
      capture?.stop();
      capture = null;
      void call('/session', { body: { active: false } }).catch(() => {});
    },
    sendText(text) {
      const clean = String(text ?? '').trim();
      if (!clean) return false;
      emit({ type: 'transcript', role: 'user', text: clean, final: true });
      void runTurn(clean, guessLanguage(clean));
      return true;
    },
    sendMapEvent: () => true,
    ignoreButtonClick: () => spaceHeld,
    bindControls() {
      documentRef?.addEventListener('keydown', onKeyDown, true);
      documentRef?.addEventListener('keyup', onKeyUp, true);
      signal?.addEventListener('abort', unbindKeys, { once: true });
    },
  };
}
