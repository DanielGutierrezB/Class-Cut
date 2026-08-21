'use strict';
/**
 * tools/align-all.js — Alinea las clases que ya tengan transcript y muestra el
 * resultado por bloque. Es la herramienta con la que se mira si el alineado está
 * haciendo lo que dice.
 *
 *   node tools/align-all.js /ruta/al/curso [--clase 4] [--detalle]
 */

const scanner = require('../engine/course-scan');
const workspace = require('../engine/workspace');
const align = require('../engine/align');
const onset = require('../engine/vendor/audio-onset');

const root = process.argv[2];
const only = argOf('--clase');
const detail = process.argv.includes('--detalle');

function argOf(flag) {
    const i = process.argv.indexOf(flag);
    return i === -1 ? null : Number(process.argv[i + 1]);
}

function fmt(seconds) {
    if (seconds == null) return '—';
    const s = Math.max(0, seconds);
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function sign(n) {
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}s`;
}

if (!root) {
    console.error('Falta la ruta. Uso: node tools/align-all.js /ruta/al/curso [--clase N] [--detalle]');
    process.exit(1);
}

const scan = scanner.scan(root);
if (!scan.ok) {
    console.error(scan.error);
    process.exit(1);
}

const totals = { alta: 0, media: 0, baja: 0, blocks: 0, classes: 0, sinTranscript: 0 };

for (const cls of scan.classes) {
    if (only != null && cls.classNumber !== only) continue;

    const transcript = workspace.readJson(workspace.artifact(scan.root, cls.sequenceName, 'transcript'));
    if (!transcript || !transcript.words) {
        totals.sinTranscript++;
        continue;
    }

    const info = cls.liveMixPath ? onset.wavInfo(cls.liveMixPath) : null;
    const wav = info ? { file: cls.liveMixPath, info } : null;

    const result = align.alignClass({
        blocks: cls.blocks,
        words: transcript.words,
        wav,
        classNumber: cls.classNumber,
        clapMarkerSec: cls.clapSec,
        durationSec: cls.durationSec,
        options: { fps: cls.fps || 30 }
    });

    workspace.writeJson(workspace.artifact(scan.root, cls.sequenceName, 'align'), result);

    totals.classes++;
    totals.blocks += result.stats.blocks;
    totals.alta += result.stats.confidence.alta;
    totals.media += result.stats.confidence.media;
    totals.baja += result.stats.confidence.baja;

    console.log(`\n━━ Clase ${cls.classNumber} · ${result.stats.blocks} bloques · ` +
        `alta ${result.stats.confidence.alta} · media ${result.stats.confidence.media} · baja ${result.stats.confidence.baja}`);
    console.log(`   claqueta: ${result.offset.reason}`);
    console.log(`   desfase aplicado: ${result.offset.applied ? sign(result.offset.appliedSec) : 'ninguno'}`);
    for (const w of result.warnings) console.log(`   ⚠ ${w.message}`);

    if (!detail) continue;
    for (const block of result.blocks) {
        const mark = block.confidence === 'alta' ? '✓' : (block.confidence === 'media' ? '~' : '✗');
        console.log(`   ${mark} ${String(block.index + 1).padStart(2)}. ` +
            `${fmt(block.xmlStartSec)}→${fmt(block.xmlEndSec)}  ⇒  ${fmt(block.startSec)}→${fmt(block.endSec)}  ` +
            `[${sign(block.in.shiftSec)} / ${sign(block.out.shiftSec)}] ${block.view} ` +
            `in:${block.in.score == null ? '—' : block.in.score.toFixed(2)} out:${block.out.score == null ? '—' : block.out.score.toFixed(2)}`);
        if (block.confidence !== 'alta') {
            console.log(`        in:  ${block.in.reason}`);
            console.log(`        out: ${block.out.reason}`);
        }
        for (const p of block.problems) console.log(`        ⚠ ${p}`);
    }
}

const total = totals.alta + totals.media + totals.baja;
console.log(`\n${totals.classes} clases · ${totals.blocks} bloques`);
if (total) {
    const pct = n => `${((n / total) * 100).toFixed(1)}%`;
    console.log(`alta ${totals.alta} (${pct(totals.alta)}) · media ${totals.media} (${pct(totals.media)}) · baja ${totals.baja} (${pct(totals.baja)})`);
}
if (totals.sinTranscript) console.log(`${totals.sinTranscript} clases sin transcript todavía`);
