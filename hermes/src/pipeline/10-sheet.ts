import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { ScoredLead } from './types.js';
import { env } from '../core/env.js';
import { localDate } from '../core/config.js';
import { log } from '../core/logger.js';

/**
 * Phase 10 — build the .xlsx (master prompt §7 Phase 10).
 *
 * One row per lead, sorted by quality_score desc, with every field plus the
 * audit bullets, both pitch variants, and a blank preview-link column. The
 * sheet is the deliverable Marvin actually works from, so it's readable:
 * frozen header, colour-banded score, wrapped pitch cells.
 */

export async function buildWorkbook(leads: ScoredLead[], city: string, niche: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hermes';
  wb.created = new Date();

  const ws = wb.addWorksheet('Leads', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: '#', key: 'rank', width: 5 },
    { header: 'Score', key: 'score', width: 8 },
    { header: 'Business', key: 'name', width: 32 },
    { header: 'Address', key: 'address', width: 34 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'WhatsApp', key: 'whatsapp', width: 16 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Website', key: 'website', width: 30 },
    { header: 'Instagram', key: 'instagram', width: 26 },
    { header: 'Facebook', key: 'facebook', width: 26 },
    { header: 'Rating', key: 'rating', width: 8 },
    { header: 'Reviews', key: 'reviews', width: 9 },
    { header: 'Strengths', key: 'strengths', width: 40 },
    { header: 'Weaknesses', key: 'weaknesses', width: 40 },
    { header: 'Service fit', key: 'fit', width: 40 },
    { header: 'Pitch A — angle', key: 'angleA', width: 16 },
    { header: 'Pitch A — subject', key: 'subjectA', width: 34 },
    { header: 'Pitch A — body', key: 'bodyA', width: 60 },
    { header: 'Pitch B — angle', key: 'angleB', width: 16 },
    { header: 'Pitch B — subject', key: 'subjectB', width: 34 },
    { header: 'Pitch B — body', key: 'bodyB', width: 60 },
    { header: 'Preview link', key: 'preview', width: 24 },
  ];

  // Header styling.
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;

  leads.forEach((lead, i) => {
    const a = lead.pitches.find((p) => p.variant === 'A');
    const b = lead.pitches.find((p) => p.variant === 'B');
    const audit = lead.audit;

    const row = ws.addRow({
      rank: i + 1,
      score: lead.qualityScore,
      name: lead.name,
      address: lead.address ?? '',
      phone: lead.phone ?? '',
      whatsapp: lead.enrichment?.whatsapp ?? '',
      email: lead.enrichment?.email ?? '',
      website: lead.website ?? '—',
      instagram: lead.enrichment?.instagram ?? '',
      facebook: lead.enrichment?.facebook ?? '',
      rating: lead.rating ?? '',
      reviews: lead.reviewsCount ?? '',
      strengths: bullets(audit?.strengths),
      weaknesses: bullets(audit?.weaknesses),
      fit: bullets(audit?.serviceFit),
      angleA: a?.angle ?? '',
      subjectA: a?.subject ?? '',
      bodyA: a?.body ?? '',
      angleB: b?.angle ?? '',
      subjectB: b?.subject ?? '',
      bodyB: b?.body ?? '',
      preview: '', // filled by Marvin's preview system later
    });

    row.alignment = { vertical: 'top', wrapText: true };
    // Colour-band the score cell: hot leads green, cool leads amber.
    const scoreCell = row.getCell('score');
    scoreCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: scoreColor(lead.qualityScore) },
    };
    scoreCell.font = { bold: true };
    scoreCell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  ws.autoFilter = { from: 'A1', to: 'V1' };

  const dir = env.OUT_DIR;
  await mkdir(dir, { recursive: true });
  const safeNiche = niche.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const safeCity = city.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = path.join(dir, `hermes-${safeCity}-${safeNiche}-${localDate()}.xlsx`);

  await wb.xlsx.writeFile(file);
  log.ok(`wrote spreadsheet: ${file}`);
  return file;
}

function bullets(items?: string[]): string {
  if (!items?.length) return '';
  return items.map((i) => `• ${i}`).join('\n');
}

function scoreColor(score: number): string {
  if (score >= 75) return 'FFB7E4C7'; // green
  if (score >= 55) return 'FFFFF3B0'; // amber
  return 'FFF8D7DA'; // soft red
}
