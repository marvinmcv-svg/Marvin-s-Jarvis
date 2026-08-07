import { closeDb } from '../db/client.js';
import { dumpActive, recallText } from '../memory/memory.js';
import { history as weightHistory, activeWeights, rollback } from '../memory/weights.js';
import { standings, PITCH_ANGLES } from '../memory/playbook.js';
import { log } from '../core/logger.js';

/**
 * `memory` CLI — inspect and steer what Hermes has learned.
 *
 * Not part of the automated pipeline; a hand tool for Marvin to see inside the
 * agent's head. Subcommands:
 *   memory dump                 — every active memory, by confidence
 *   memory recall <city> <niche> — what he'd inject for that target
 *   memory weights              — score-weight versions + the active vector
 *   memory rollback <version>   — revert to a prior weight version
 *   memory angles <niche>       — pitch-angle standings for a niche
 */
async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  try {
    switch (cmd) {
      case 'dump': {
        const rows = await dumpActive();
        if (!rows.length) {
          console.log('No memories yet — Hermes has not run enough to learn anything.');
          break;
        }
        console.log(`\n${rows.length} active memories (by confidence):\n`);
        for (const m of rows) {
          const scope = m.scopeKey ? `${m.scope}/${m.scopeKey}` : m.scope;
          console.log(`  [${(m.confidence).toFixed(2)}] (${m.kind}, ${scope}, ×${m.evidenceCount}) ${m.content}`);
        }
        break;
      }

      case 'recall': {
        const [city, niche] = args;
        if (!city || !niche) {
          console.log('usage: pnpm memory recall "<city>" "<niche>"');
          break;
        }
        const lessons = await recallText({ city, niche });
        console.log(`\nWhat Hermes would inject for ${city} / ${niche}:\n`);
        lessons.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
        if (!lessons.length) console.log('  (nothing yet)');
        break;
      }

      case 'weights': {
        const { weights, version } = await activeWeights();
        console.log(`\nActive score weights — v${version}:\n`);
        for (const [k, v] of Object.entries(weights).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${k.padEnd(24)} ${v}`);
        }
        const hist = await weightHistory();
        console.log('\nVersion history:');
        for (const h of hist) {
          console.log(`  v${h.version}${h.isActive ? ' (active)' : ''} — calibration ${h.calibration?.toFixed(3) ?? 'n/a'} — ${h.rationale ?? ''}`);
        }
        break;
      }

      case 'rollback': {
        const version = Number(args[0]);
        if (!Number.isInteger(version)) {
          console.log('usage: pnpm memory rollback <version>');
          break;
        }
        const ok = await rollback(version);
        console.log(ok ? `Rolled back to weights v${version}.` : `No weight version ${version} found.`);
        break;
      }

      case 'angles': {
        const niche = args[0];
        if (!niche) {
          console.log('usage: pnpm memory angles "<niche>"');
          break;
        }
        const rows = await standings(niche, 1);
        console.log(`\nPitch-angle standings for ${niche}:\n`);
        if (!rows.length) {
          console.log(`  no data yet. Angles in rotation: ${PITCH_ANGLES.join(', ')}`);
        } else {
          for (const r of rows) {
            console.log(`  ${r.angle.padEnd(16)} ${(r.replyRate * 100).toFixed(1)}%  (${r.replies}/${r.sent}, ${r.positive} positive)`);
          }
        }
        break;
      }

      default:
        console.log('Hermes memory CLI. Commands: dump | recall <city> <niche> | weights | rollback <v> | angles <niche>');
    }
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
