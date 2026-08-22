'use strict';
/**
 * tools/bench-models.js — ¿Hace falta el modelo grande?
 *
 * El modelo que estamos usando pesa 17 GB, y eso decide de qué tamaño es el
 * instalador. La pregunta no se contesta leyendo specs: se contesta corriendo
 * las mismas decisiones de corte con cada modelo y viendo en cuántas coincide
 * con el grande, que es el que ya validamos contra el curso real.
 *
 * Lo que se mide, por modelo:
 *   - acuerdo: bordes que caen en el mismo frame que con el modelo grande
 *   - fallos:  veces que contestó algo que no era una opción válida
 *   - tiempo:  lo que tarda en una clase entera
 *
 *   node tools/bench-models.js /ruta/al/curso --clases 1,5,12 --modelos qwen3:4b,gemma3:1b
 */

const scanner = require('../engine/course-scan');
const probe = require('../engine/media-probe');
const transcribe = require('../engine/transcribe');
const onset = require('../engine/vendor/audio-onset');
const align = require('../engine/align');
const cutRefine = require('../engine/cut-refine');
const coherence = require('../engine/coherence');
const ai = require('../engine/ai-local');

const root = process.argv[2];
const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
};

if (!root) {
    console.error('Falta la ruta. Uso: node tools/bench-models.js /ruta/al/curso [--clases 1,5] [--modelos a,b]');
    process.exit(1);
}

const wanted = (arg('clases') || '1,5,12').split(',').map(Number);
const models = (arg('modelos') || 'qwen3:4b').split(',').filter(Boolean);
const baseline = arg('base') || ai.DEFAULTS.model;

/** Los bordes de una clase, en frames, que es la unidad en la que importa. */
function edgesOf(alignResult, fps) {
    const out = new Map();
    for (const block of alignResult.blocks || []) {
        out.set(`${block.index}:IN`, Math.round(block.startSec * fps));
        out.set(`${block.index}:OUT`, Math.round(block.endSec * fps));
    }
    return out;
}

/**
 * Un porcentaje de acuerdo no dice si el que se movió eligió mejor o peor, y esa
 * es la pregunta. Acá se guarda lo que se oiría en cada borde: la frase que
 * queda del lado que se conserva y la que queda del lado que se corta.
 */
function contextAt(words, timeSec, kind) {
    const spoken = words.filter(w => (w.text || '').trim());
    const before = spoken.filter(w => w.end <= timeSec + 0.02).slice(-9);
    const after = spoken.filter(w => w.start >= timeSec - 0.02).slice(0, 9);
    const text = list => list.map(w => w.text.trim()).join(' ').trim() || '—';
    return kind === 'IN'
        ? { corta: text(before), conserva: text(after) }
        : { conserva: text(before), corta: text(after) };
}

function timecode(seconds) {
    const s = Math.max(0, seconds);
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function compare(base, other) {
    let same = 0;
    let moved = 0;
    let maxDrift = 0;
    for (const [key, frame] of base) {
        if (!other.has(key)) continue;
        const diff = Math.abs(other.get(key) - frame);
        if (diff === 0) same++;
        else {
            moved++;
            maxDrift = Math.max(maxDrift, diff);
        }
    }
    return { same, moved, total: base.size, maxDrift };
}

(async () => {
    const scan = scanner.scan(root);
    if (!scan.ok) {
        console.error(scan.error);
        process.exit(1);
    }
    const classes = scan.classes.filter(c => c.processable && wanted.includes(c.classNumber));
    if (!classes.length) {
        console.error('Ninguna de esas clases se puede procesar.');
        process.exit(1);
    }
    await probe.probeClasses(classes);

    // El alineado determinista es idéntico para todos los modelos, así que se
    // hace una sola vez por clase y de ahí sale una copia limpia para cada uno.
    const prepared = [];
    for (const cls of classes) {
        const fps = cls.fps || 30;
        const transcript = await transcribe.transcribeClass({
            root: scan.root,
            sequenceName: cls.sequenceName,
            wavPath: cls.liveMixPath,
            fps
        });
        const info = cls.liveMixPath ? onset.wavInfo(cls.liveMixPath) : null;
        prepared.push({
            cls,
            fps,
            words: transcript.words,
            wav: info ? { file: cls.liveMixPath, info } : null
        });
        process.stdout.write(`\rpreparando… clase ${cls.classNumber}   `);
    }
    console.log(`\r${prepared.length} clases listas · ${prepared.reduce((n, p) => n + p.words.length, 0)} palabras\n`);

    const freshAlign = p => align.alignClass({
        blocks: p.cls.blocks || [],
        words: p.words,
        wav: p.wav,
        classNumber: p.cls.classNumber,
        clapMarkerSec: p.cls.clapSec,
        durationSec: p.cls.durationSec,
        options: { fps: p.fps }
    });

    async function runWith(model) {
        ai.configure({ model });
        const started = Date.now();
        const stats = { consultas: 0, fallosDelModelo: 0, cambiados: 0 };
        const edges = new Map();
        const detail = new Map();
        let findings = 0;

        for (const p of prepared) {
            const alignResult = freshAlign(p);
            const s = await cutRefine.refineClass({
                alignResult, words: p.words, wav: p.wav,
                options: { fps: p.fps }, useAi: true
            });
            stats.consultas += s.consultas;
            stats.fallosDelModelo += s.fallosDelModelo;
            stats.cambiados += s.cambiados;
            for (const [k, v] of edgesOf(alignResult, p.fps)) {
                edges.set(`${p.cls.classNumber}/${k}`, v);
            }
            for (const block of alignResult.blocks || []) {
                for (const kind of ['IN', 'OUT']) {
                    const edge = kind === 'IN' ? block.in : block.out;
                    if (!edge) continue;
                    const at = kind === 'IN' ? block.startSec : block.endSec;
                    detail.set(`${p.cls.classNumber}/${block.index}:${kind}`, {
                        at,
                        words: p.words,
                        kind,
                        reason: edge.refine ? edge.refine.reason : '',
                        decidedBy: edge.refine ? edge.refine.decidedBy : ''
                    });
                }
            }
            const review = await coherence.reviewClass({
                alignResult, words: p.words, useAi: true
            });
            findings += (review.findings || []).length;
        }
        return { model, edges, detail, stats, findings, secs: (Date.now() - started) / 1000 };
    }

    console.log(`base: ${baseline}`);
    const base = await runWith(baseline);
    console.log(`  ${base.edges.size} bordes · ${base.stats.consultas} consultas · ` +
        `${base.stats.fallosDelModelo} respuestas inválidas · ${base.findings} hallazgos · ` +
        `${Math.round(base.secs)}s\n`);

    for (const model of models) {
        if (model === baseline) continue;
        console.log(`contra: ${model}`);
        let run;
        try {
            run = await runWith(model);
        } catch (err) {
            console.log(`  falló: ${err.message}\n`);
            continue;
        }
        const cmp = compare(base.edges, run.edges);
        const pct = cmp.total ? Math.round((cmp.same / cmp.total) * 100) : 0;
        console.log(`  acuerdo con ${baseline}: ${cmp.same}/${cmp.total} bordes (${pct}%)` +
            (cmp.moved ? ` · ${cmp.moved} movidos, el peor ${cmp.maxDrift} frames` : ''));
        console.log(`  ${run.stats.consultas} consultas · ${run.stats.fallosDelModelo} respuestas inválidas · ` +
            `${run.findings} hallazgos · ${Math.round(run.secs)}s ` +
            `(${(base.secs / Math.max(1, run.secs)).toFixed(1)}× vs el grande)`);

        for (const [key, frame] of base.edges) {
            if (!run.edges.has(key) || run.edges.get(key) === frame) continue;
            const a = base.detail.get(key);
            const b = run.detail.get(key);
            if (!a || !b) continue;
            const ca = contextAt(a.words, a.at, a.kind);
            const cb = contextAt(b.words, b.at, b.kind);
            console.log(`\n  ── ${key}`);
            console.log(`     ${baseline} @ ${timecode(a.at)} (${a.decidedBy || 'regla'})`);
            console.log(`        conserva …${ca.conserva.slice(-70)}`);
            console.log(`        corta     ${ca.corta.slice(0, 70)}…`);
            console.log(`     ${model} @ ${timecode(b.at)} (${b.decidedBy || 'regla'})`);
            console.log(`        conserva …${cb.conserva.slice(-70)}`);
            console.log(`        corta     ${cb.corta.slice(0, 70)}…`);
        }
        console.log('');
    }
})();
