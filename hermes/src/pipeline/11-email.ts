import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import type { ScoredLead } from './types.js';
import type { NicheRun } from '../db/schema.js';
import { env, hasEmailTransport } from '../core/env.js';
import { displayDate } from '../core/config.js';
import { log } from '../core/logger.js';

/**
 * Phase 11 — email Marvin the spreadsheet (master prompt §7 Phase 11).
 *
 * Free-first: Resend if configured (cleaner), else Gmail SMTP via Nodemailer.
 * The body is a quick digest — niche, city, the three hottest names, and where
 * he is in the weekly rhythm — so the email is useful even before he opens the
 * attachment.
 */

export type EmailKind = 'digest' | 'alert';

export async function sendDigest(opts: {
  filePath: string;
  leads: ScoredLead[];
  run: NicheRun;
  city: string;
  niche: string;
}): Promise<void> {
  const { filePath, leads, run, city, niche } = opts;

  const dayInWeek = Math.floor(run.sentCount / run.dailyTarget) + 1;
  const totalDays = Math.ceil(run.weekCap / run.dailyTarget);
  const top3 = leads.slice(0, 3).map((l, i) => `${i + 1}. ${l.name} (score ${l.qualityScore})`);

  const subject = `🎯 ${niche} · ${city} — ${leads.length} leads — ${displayDate()}`;
  const text = [
    `${leads.length} audited, ranked, pitch-ready leads for ${niche} in ${city}.`,
    '',
    'Hottest three today:',
    ...top3,
    '',
    `Week progress: day ${dayInWeek}/${totalDays} · ${run.sentCount + leads.length}/${run.weekCap} sent this niche.`,
    '',
    'Spreadsheet attached. Every lead has two drafted pitch variants (A/B) — nothing has been sent to anyone.',
    '',
    '— Hermes',
  ].join('\n');

  const html = digestHtml(leads.length, niche, city, top3, dayInWeek, totalDays, run);

  if (env.NO_EMAIL) {
    log.warn(`NO_EMAIL set — skipping delivery. Sheet is at ${filePath}`);
    return;
  }
  if (!hasEmailTransport()) {
    log.warn(`no email transport configured — skipping delivery. Sheet is at ${filePath}`);
    return;
  }

  await deliver({ subject, text, html, attachmentPath: filePath });
  log.ok(`emailed digest to ${env.EMAIL_TO}`);
}

/** Phase 0 self-healing: "scrapers down" alert instead of under-delivering. */
export async function sendAlert(subjectLine: string, body: string): Promise<void> {
  if (env.NO_EMAIL || !hasEmailTransport()) {
    log.error(`ALERT (not emailed — no transport): ${subjectLine}\n${body}`);
    return;
  }
  await deliver({
    subject: `⚠️ Hermes alert — ${subjectLine}`,
    text: body,
    html: `<pre style="font-family:ui-monospace,monospace">${escapeHtml(body)}</pre>`,
  });
  log.warn(`sent alert email: ${subjectLine}`);
}

async function deliver(msg: {
  subject: string;
  text: string;
  html: string;
  attachmentPath?: string;
}): Promise<void> {
  if (env.RESEND_API_KEY) {
    const resend = new Resend(env.RESEND_API_KEY);
    const attachments = msg.attachmentPath
      ? [{ filename: path.basename(msg.attachmentPath), content: await readFile(msg.attachmentPath) }]
      : undefined;

    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: env.EMAIL_TO,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(attachments ? { attachments } : {}),
    });
    if (error) throw new Error(`Resend failed: ${JSON.stringify(error)}`);
    return;
  }

  // SMTP fallback (Gmail app password).
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
  });
  await transport.sendMail({
    from: env.EMAIL_FROM,
    to: env.EMAIL_TO,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    ...(msg.attachmentPath ? { attachments: [{ path: msg.attachmentPath }] } : {}),
  });
}

function digestHtml(
  count: number,
  niche: string,
  city: string,
  top3: string[],
  day: number,
  totalDays: number,
  run: NicheRun,
): string {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 4px">🎯 ${count} leads — ${escapeHtml(niche)} · ${escapeHtml(city)}</h2>
    <p style="color:#555;margin:0 0 16px">${displayDate()} · audited, ranked, pitch-ready</p>
    <div style="background:#f3f4f6;border-radius:10px;padding:14px 16px;margin-bottom:16px">
      <strong>Hottest three today</strong>
      <ol style="margin:8px 0 0;padding-left:18px">
        ${top3.map((t) => `<li>${escapeHtml(t.replace(/^\d+\.\s*/, ''))}</li>`).join('')}
      </ol>
    </div>
    <p style="margin:0 0 6px"><strong>Week progress:</strong> day ${day}/${totalDays} ·
      ${run.sentCount + count}/${run.weekCap} sent this niche.</p>
    <p style="color:#555;font-size:14px;margin:16px 0 0">
      Spreadsheet attached. Every lead has two drafted pitch variants (A/B).
      Nothing has been sent to any lead — these are drafts for you.
    </p>
    <p style="color:#888;font-size:13px;margin-top:20px">— Hermes</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
