'use strict';
/**
 * tools/process-all.js — El pipeline completo sobre una ruta, sin abrir la app.
 *
 *   node tools/process-all.js /ruta/al/curso [--clase 4] [--force]
 */

const scanner = require('../engine/course-scan');
const probe = require('../engine/media-probe');
const pipeline = require('../engine/pipeline');

const root = process.argv[2];
const force = process.argv.includes('--force');
const onlyIndex = process.argv.indexOf('--clase');
const only = onlyIndex === -1 ? null : Number(process.argv[onlyIndex + 1]);

if (!root) {
    console.error('Falta la ruta. Uso: node tools/process-all.js /ruta/al/curso [--clase N] [--force]');
    process.exit(1);
}

function fmt(seconds) {
    if (seconds == null) return '—';
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

(async () => {
    const scan = scanner.scan(root);
    if (!scan.ok) {
        console.error(scan.error);
        process.exit(1);
    }

    const classes = scan.classes.filter(c => c.processable && (only == null || c.classNumber === only));
    console.log(`${scan.kind} · ${classes.length} clases a procesar · salida en ${scan.outputDir}\n`);

    await probe.probeClasses(classes);

    const started = Date.now();
    let ok = 0;
    let label = '';

    // `processClasses` y no `processClass` en un bucle: el modelo local se
    // levanta una vez para todo el lote, y es el mismo camino que corre la app.
    await pipeline.processClasses({
        root: scan.root,
        classes,
        force,
        onStage: (stage, info) => {
            const detail = info.percent != null ? ` ${info.percent}%` : '';
            process.stdout.write(`\r${label} · ${stage}${detail}          `);
        },
        onClass: (phase, info) => {
            if (phase === 'modelo') {
                console.log(`modelo: ${info.modelo.reason}\n`);
                return;
            }
            if (phase === 'empieza') {
                label = `${info.cls.classNumber}. ${info.cls.sequenceName}`;
                process.stdout.write(`${label} `);
                return;
            }

            const { result, cls } = info;
            if (!result.ok) {
                console.log(`\r${label} · FALLÓ: ${result.error}          `);
                return;
            }
            ok++;
            const conf = result.stats.confidence;
            console.log(`\r${label} · ` +
                `${result.totals.kept} bloques · ${fmt(result.totals.keepSec)} de ${fmt(cls.durationSec)} · ` +
                `desfase ${result.offset.appliedSec.toFixed(2)}s (${result.offset.source}) · ` +
                `alta ${conf.alta} media ${conf.media} baja ${conf.baja}          `);
            for (const w of result.warnings) console.log(`     ⚠ ${w.message}`);
        }
    });

    console.log(`\n${ok}/${classes.length} clases exportadas en ${fmt((Date.now() - started) / 1000)}`);
    console.log(`XML en ${scan.outputDir}`);
})();
