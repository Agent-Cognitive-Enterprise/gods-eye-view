// Text-to-speech with Piper: one short-lived process per utterance, raw PCM on
// stdout wrapped as WAV here. One synthesis at a time with a small queue, a
// hard timeout and bounded output; text is plain and length-capped. No network.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const MAX_SPEAK_CHARS = 600;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_QUEUE = 3;

/** Plain, speakable text: no markup or control characters, bounded. */
export function speakableText(value) {
  return (
    String(value ?? '')
      .replace(/<[^>]*>/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SPEAK_CHARS)
  );
}

/** A 16-bit mono PCM WAV around raw samples. */
export function wavFromPcm16(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * @param {{exe?: string, voices?: Record<string, string>,
 *   spawnImpl?: Function}} options
 */
export function createPiper({ exe, voices = {}, spawnImpl = spawn } = {}) {
  const usable = Object.fromEntries(
    Object.entries(voices).filter(([, model]) => model && fs.existsSync(model)),
  );
  const available = Boolean(
    exe && fs.existsSync(exe) && Object.keys(usable).length,
  );
  const rates = {};
  for (const [lang, model] of Object.entries(usable)) {
    try {
      rates[lang] =
        JSON.parse(fs.readFileSync(`${model}.json`, 'utf8'))?.audio
          ?.sample_rate || 22050;
    } catch {
      rates[lang] = 22050;
    }
  }
  let chain = Promise.resolve();
  let queued = 0;

  function run(text, lang) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(exe, ['--model', usable[lang], '--output-raw'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('speech synthesis timed out'));
      }, TIMEOUT_MS);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_AUDIO_BYTES) {
          child.kill();
          reject(new Error('speech output too large'));
          return;
        }
        chunks.push(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || !size)
          reject(new Error(`speech synthesis failed (${code})`));
        else resolve(wavFromPcm16(Buffer.concat(chunks), rates[lang]));
      });
      child.stdin.end(`${text}\n`, 'utf8');
    });
  }

  return {
    available,
    languages: Object.keys(usable),
    /** Synthesize `text` in `lang` ('en' | 'ru'); resolves to WAV bytes. */
    speak(text, lang) {
      const clean = speakableText(text);
      if (!available)
        return Promise.reject(new Error('speech synthesis not installed'));
      if (!clean) return Promise.reject(new Error('nothing to say'));
      const voice = usable[lang]
        ? lang
        : usable.en
          ? 'en'
          : Object.keys(usable)[0];
      if (queued >= MAX_QUEUE) return Promise.reject(new Error('speech busy'));
      queued += 1;
      const job = chain.then(() => run(clean, voice));
      chain = job
        .catch(() => {})
        .finally(() => {
          queued -= 1;
        });
      return job.then((wav) => ({ wav, lang: voice }));
    },
  };
}
