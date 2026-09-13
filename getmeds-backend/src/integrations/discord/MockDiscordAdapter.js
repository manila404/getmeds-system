'use strict';

/**
 * Discord without the network. Keeps what would have been posted in `sent`
 * (tests assert against it) and hands back made-up ids.
 *
 * services/discordAuditService.js logs each post as [DISCORD_MOCK] and never
 * saves a mock id to the database: a made-up thread id stored now would break
 * every post to that order the day the mode is switched to live.
 */
class MockDiscordAdapter {
  constructor() {
    this.mode = 'mock';
    this.sent = [];
    this.seq = 0;
  }

  async post(payload, { threadId } = {}) {
    const messageId = `mock-${++this.seq}`;
    this.sent.push({ messageId, threadId: threadId ?? null, payload });
    return { messageId, attempts: 1 };
  }

  async startThread(messageId, name) {
    return { id: messageId, name };
  }

  stats() {
    return null;
  }
}

module.exports = MockDiscordAdapter;
