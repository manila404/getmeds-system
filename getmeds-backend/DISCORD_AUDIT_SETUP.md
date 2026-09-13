# Order audit in Discord

Every order raised in this app gets a thread in a Discord channel, named with its order id (for example `GM-20260913-0001`). Each entry in the order's audit trail becomes one post in that thread: what happened, the status change, who did it and in which role, and when.

```
Order submitted          Draft → Pending management approval          Test Salesperson · Salesperson
Management approved      Pending management approval → Sales Order…   Test Management · Management
Finance verified         Sales Order created → Ready for dispatch     Test Finance · Finance
Order dispatched         Picking and packing → Dispatched             Test Dispatch · Dispatch
```

It is off until you switch it on, and it cannot slow down or fail an order.

## What reaches Discord, and what doesn't

- **Posted:** the event, the status change, the person's name and role, the time.
- **Never posted:** notes and metadata. They can hold customer names, amounts and payment references, and anyone who can read the channel reads the thread. `logEvent` doesn't even pass them to the Discord code.
- **Skipped:** orders imported from Zoho (`ZOHO-…`), and history backfilled from Zoho. One import run writes thousands of backfilled events; posting them would bury the channel.
- **Only after commit:** `logEvent` hands the event over through `db.afterCommit`, so an action that is rolled back never appears in Discord.

## Switching it on

1. **Create the channel.** In Discord, create `#order-audit`. In its settings, go to **Integrations → Webhooks → New Webhook**, point it at `#order-audit` and click **Copy Webhook URL**.
2. **Give the bot access.** A webhook can post but can't start threads, so a bot does that. In the Discord Developer Portal, open your application's **OAuth2 → OAuth2 URL Generator**, tick the `bot` scope and the **View Channels**, **Read Message History** and **Create Public Threads** permissions, open the generated URL and add the bot to the server. If `#order-audit` is private, add the bot in the channel's **Permissions** too. Copy the bot token from the **Bot** page.
3. **Create the table.** Run `npm run migrate:pg` once. It adds `order_audit_threads`, which remembers each order's thread. It also applies everything else in `schema.pg.sql`, so run it when this branch's schema is ready to go.
4. **Try mock mode first.** In `.env`:

   ```
   DISCORD_AUDIT_ENABLED=true
   DISCORD_AUDIT_MODE=mock
   ```

   Restart and act on an order. The console shows a `[DISCORD_MOCK]` line for each event, and nothing is sent.
5. **Go live.** In `.env`:

   ```
   DISCORD_AUDIT_MODE=live
   DISCORD_AUDIT_WEBHOOK_URL=<the webhook URL>
   DISCORD_BOT_TOKEN=<the bot token>
   ```

   Restart. The console says `[DISCORD] audit mode=live`, and the next event on an order starts its thread.

The webhook URL and the bot token are secrets: anyone with the URL can post in the channel, and anyone with the token can act as the bot.

## Pace

Discord allows about 30 messages a minute per channel. Posts go through a send queue (`src/integrations/discord/DiscordQueue.js`) that sends one at a time and follows Discord's rate-limit headers, so a busy hour waits in line instead of failing. `DISCORD_MAX_PER_MINUTE` sets the cap. An order's first event costs two messages (the starter in the channel and the first post) plus starting the thread.

## When something is wrong

| Console says | Fix |
|---|---|
| `DISCORD_AUDIT_MODE=live needs …` | Set both `DISCORD_AUDIT_WEBHOOK_URL` and `DISCORD_BOT_TOKEN`, then restart. Until then audit threads are off. |
| `order_audit_threads does not exist yet` | Run `npm run migrate:pg`, then restart. |
| `The bot can't start threads (403)` | Invite the bot again with **Create Public Threads**, and give it access to `#order-audit`. |
| `Discord refused DISCORD_BOT_TOKEN (401)` | Reset the token on the bot page, update `.env`, restart. |
| `Discord doesn't know this webhook (404)` | The webhook was deleted or the URL is incomplete. Create a new one. |

A failed post is logged and dropped; the order carries on. The audit trail in the database, and the order's timeline in the app, stay complete either way.

## Where it lives

| File | What it does |
|---|---|
| `src/services/discordAuditService.js` | Decides what is posted, keeps one thread per order, and posts each order's events in order |
| `src/integrations/discord/` | Mock and live adapters, chosen in `index.js` like the Zoho integration, plus the send queue |
| `src/services/auditService.js` | `logEvent` hands each event over after commit |
| `src/db/pg.js` | `db.afterCommit` |
| `src/db/schema.pg.sql` | `order_audit_threads` |
| `tests/discordAudit.test.js` | The mirror's rules, with no database or Discord needed |
| `tests/afterCommit.test.js` | Posting waits for `COMMIT` and is dropped on `ROLLBACK` (needs the test Postgres) |
