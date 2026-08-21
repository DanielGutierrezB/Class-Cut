'use strict';
/**
 * tools/transcribe-all.js — Transcribe todas las clases de una ruta, sin abrir la
 * app. Es la herramienta de desarrollo con la que se generan los transcripts
 * reales con los que se prueba el alineado.
 *
 *   node tools/transcribe-all.js /ruta/al/curso [--force]
 */

const scanner = require('../engine/course-scan');
const transcribe = require('../engine/transcribe');

const root = process.argv[2];
const force = process.argv.includes('--force');

if (!root) {
    console.error('Falta la ruta. Uso: node tools/transcribe-all.js /ruta/al/curso [--force]');
    process.exit(1);
}

function fmt(seconds) {
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

(async () => {
    const scan = scanner.scan(root);
    if (!scan.ok) {
        console.error(scan.error);
        process.exit(1);
    }
    console.log(`${scan.kind} · ${scan.classCount} clases · salida en ${scan.outputDir}\n`);

    const started = Date.now();
    let done = 0;
    for (const cls of scan.classes) {
        if (!cls.liveMixPath || !cls.sequenceName) {
            console.log(`— ${cls.folderName}: sin Live-Mix o sin XML, se saltea`);
            continue;
        }
        const t0 = Date.now();
        process.stdout.write(`${cls.classNumber}. ${cls.sequenceName} … `);
        try {
            const result = await transcribe.transcribeClass({
                root: scan.root,
                sequenceName: cls.sequenceName,
                wavPath: cls.liveMixPath,
                force,
                onProgress: p => process.stdout.write(`\r${cls.classNumber}. ${cls.sequenceName} … ${p}%   `)
            });
            done++;
            const how = result.fromCache ? 'ya estaba' : fmt((Date.now() - t0) / 1000);
            console.log(`\r${cls.classNumber}. ${cls.sequenceName} · ${result.wordCount} palabras · ${result.language} · ${how}      `);
        } catch (err) {
            console.log(`\r${cls.classNumber}. ${cls.sequenceName} · FALLÓ (${err.code}): ${err.message}`);
        }
    }
    console.log(`\n${done} clases transcriptas en ${fmt((Date.now() - started) / 1000)}`);
})();
