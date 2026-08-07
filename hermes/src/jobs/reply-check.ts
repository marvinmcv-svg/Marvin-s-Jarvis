import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';
import { leads, replies, outreach, type Lead } from '../db/schema.js';
import { env, hasImap } from '../core/env.js';
import { resetUsage } from '../core/anthropic.js';
import { tryAskJson } from '../core/anthropic.js';
import { RunRecorder } from '../memory/run.js';
import { recordReply } from '../memory/playbook.js';
import { remember } from '../memory/memory.js';
import { log } from '../core/logger.js';

/**
 * The `reply-check` job (master prompt §10).
 *
 * A lighter, hourly job that watches the inbox for replies, matches them to
 * leads, and — the learning part — classifies each reply's sentiment and
 * attributes it back to the pitch angle that earned it. That attribution is
 * what lets `playbook.ts` tell tomorrow's pitch prompt which angles pull.
 *
 * // PAID-UPGRADE: swap free Gmail IMAP for Resend inbound parsing or a proper
 * // inbox API if IMAP gets flaky at volume. Only this file changes.
 */

const SENTIMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'unsubscribe'] },
    reason: { type: 'string' },
  },
  required: ['sentiment', 'reason'],
} as const;

async function main(): Promise<void> {
  resetUsage();
  if (!hasImap()) {
    log.warn('IMAP not configured (IMAP_USER / IMAP_PASS) — reply-check is a no-op.');
    return;
  }

  const recorder = await RunRecorder.start('reply-check');
  const client = new ImapFlow({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    secure: true,
    auth: { user: env.IMAP_USER!, pass: env.IMAP_PASS! },
    logger: false,
  });

  let matched = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Only look at recent unseen mail — a reply to a lead lands as a fresh message.
      const since = new Date(Date.now() - 3 * 86_400_000);
      for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase();
        if (!fromAddr) continue;

        const lead = await matchLead(fromAddr);
        if (!lead) continue;
        if (!msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId ?? `${fromAddr}:${msg.uid}`;
        const snippet = (parsed.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);

        const handled = await handleReply(lead, fromAddr, parsed.subject ?? null, snippet, messageId, recorder.id);
        if (handled) matched++;
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    log.error(`reply-check failed: ${(err as Error).message}`);
    await recorder.finish('failed', { error: (err as Error).message });
    await client.logout().catch(() => {});
    await closeDb();
    return;
  }

  await client.logout().catch(() => {});
  recorder.metric('repliesMatched', matched);
  await recorder.finish('success');
  log.ok(`reply-check done — ${matched} new replies matched`);
  await closeDb();
}

/** Match a sender to a lead by exact email, then by website domain. */
async function matchLead(fromAddr: string): Promise<Lead | null> {
  const [byEmail] = await db.select().from(leads).where(eq(leads.email, fromAddr)).limit(1);
  if (byEmail) return byEmail;

  const domain = fromAddr.split('@')[1];
  if (!domain) return null;

  // Fall back to matching the sender's domain against the lead's website host.
  const candidates = await db
    .select()
    .from(leads)
    .where(and(isNotNull(leads.website), eq(leads.status, 'sent')))
    .orderBy(desc(leads.sentAt))
    .limit(500);

  return candidates.find((l) => l.website?.toLowerCase().includes(domain)) ?? null;
}

/**
 * Record the reply, flip the lead to `replied` so Hermes stops chasing it, and
 * attribute the sentiment back to the pitch angle for the A/B learner.
 */
async function handleReply(
  lead: Lead,
  fromAddr: string,
  subject: string | null,
  snippet: string,
  messageId: string,
  runId: string,
): Promise<boolean> {
  // Which variant did this lead receive? Attribute the reply to its angle.
  const [pitch] = await db
    .select()
    .from(outreach)
    .where(eq(outreach.leadId, lead.id))
    .orderBy(desc(outreach.createdAt))
    .limit(1);

  const classification = await tryAskJson<{ sentiment: string; reason: string }>({
    tier: 'bulk',
    label: `sentiment:${lead.name.slice(0, 20)}`,
    system: 'You classify the sentiment of a business reply to a cold outreach message. Be strict: only "positive" if they show genuine interest.',
    schema: SENTIMENT_SCHEMA,
    maxTokens: 200,
    user: `Reply from ${lead.name} (${lead.niche}). Subject: ${subject ?? '(none)'}\n\n${snippet}`,
  });
  const sentiment = (classification?.sentiment ?? 'neutral') as 'positive' | 'neutral' | 'negative' | 'unsubscribe';

  // Idempotent insert — the hourly sweep must not double-count a reply.
  const [inserted] = await db
    .insert(replies)
    .values({
      leadId: lead.id,
      outreachId: pitch?.id ?? null,
      fromEmail: fromAddr,
      subject,
      snippet,
      sentiment,
      messageId,
      handled: true,
    })
    .onConflictDoNothing({ target: replies.messageId })
    .returning({ id: replies.id });

  if (!inserted) return false; // already recorded on a previous sweep

  const status = sentiment === 'unsubscribe' || sentiment === 'negative' ? 'dead' : 'replied';
  await db.update(leads).set({ status, updatedAt: new Date() }).where(eq(leads.id, lead.id));

  if (pitch?.angle) {
    await recordReply(pitch.angle, lead.niche, lead.city, sentiment);
  }

  // A reply is a strong learning signal — remember what earned it.
  if (sentiment === 'positive' && pitch?.angle) {
    await remember({
      kind: 'observation',
      content: `A ${lead.niche} lead in ${lead.city} replied positively to the "${pitch.angle}" angle. That angle is working here.`,
      scope: 'niche',
      scopeKey: `${lead.city}::${lead.niche}`,
      tags: ['pitch'],
      confidence: 0.6,
      runId,
    });
  }

  log.memory(`reply from ${lead.name} → ${sentiment} (angle: ${pitch?.angle ?? 'unknown'})`);
  return true;
}

void main();
