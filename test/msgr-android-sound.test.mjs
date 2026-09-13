import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fcmMessage } from '../supabase/functions/msgr-push/core.js';

const sounds = ['seatbelt-single', 'seatbelt-hilo', 'wood-knock', 'wood-knock-double', 'wood-marimba'];
const request = (sound) => fcmMessage({ token: 'fixture-token', title: 'Hello', body: 'World', channelId: 'dm-1', messageId: 7, sound }).message;

test('FCM defaults to wood knock and preserves all explicit sound choices', () => {
  for (const sound of [...sounds, undefined, null, '', '../bad.wav']) {
    const message = request(sound);
    const resource = (sounds.includes(sound) ? sound : 'wood-knock').replaceAll('-', '_');
    assert.equal(message.android.notification.channel_id, `msgr_sound_${resource}`);
    assert.equal(message.android.notification.sound, resource);
    assert.deepEqual(message.data, { channel_id: 'dm-1', message_id: '7' });
    assert.equal(message.android.notification.tag, 'dm-1');
    assert.deepEqual(message.notification, { title: 'Hello', body: 'World' });
  }
});

test('each Android notification audio source is a valid bundled preview WAV', () => {
  for (const sound of sounds) {
    const wav = readFileSync(new URL(`../apps/messenger/public/sounds/${sound}.wav`, import.meta.url));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.length > 44);
  }
});
