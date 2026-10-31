#!/usr/bin/env node
// Signs in to Telegram once, in this terminal, with your own account and your
// own api_id and api_hash from https://my.telegram.org. Nothing is sent anywhere
// but Telegram. The result is encrypted for this Windows user and kept outside
// the repository; the password and login code are never stored. Run it on the
// server machine, then list public channels in the FAST INTELLIGENCE panel's
// settings file.
//
//   node scripts/fast-feeds-telegram-login.mjs

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  saveLogin,
  secretFile,
  secretsSupported,
} from '../server/providers/fastfeeds/secretStore.js';

if (!secretsSupported()) {
  console.error(
    'This needs Windows: there is no protected store to save into.',
  );
  process.exit(1);
}

const { TelegramClient } = await import('teleproto').catch(() => {
  console.error(
    'The teleproto package is not installed; run npm install first.',
  );
  process.exit(1);
});
const { StringSession } = await import('teleproto/sessions/index.js');

const prompt = createInterface({ input, output });
const ask = (question) => prompt.question(question);

const apiId = Number(await ask('api_id: '));
const apiHash = (await ask('api_hash: ')).trim();
if (!Number.isInteger(apiId) || !apiHash) {
  console.error(
    'Both come from https://my.telegram.org (API development tools).',
  );
  process.exit(1);
}

const session = new StringSession('');
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 3,
});
client.setLogLevel?.('none');
await client.start({
  phoneNumber: () => ask('Phone number, with country code: '),
  phoneCode: () => ask('Code Telegram sent you: '),
  password: () => ask('Two-step verification password: '),
  onError: (error) => console.error(`Telegram refused: ${error.message}`),
});

await saveLogin({ apiId, apiHash, session: client.session.save() });
await client.disconnect();
await client.destroy?.();
prompt.close();
console.log(`Signed in. Encrypted login saved to ${secretFile()}.`);
console.log('Restart the server for it to take effect.');
process.exit(0);
