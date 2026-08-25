'use strict';
/**
 * ver-hallazgos.js — Qué encontró la lectura y por qué no se pudo arreglar.
 *
 * Cuando el repaso deja algo sin arreglar hay dos explicaciones posibles y no se
 * distinguen desde el resumen: que el hallazgo no sea de los que se saben
 * arreglar, o que sí lo sea y el arreglo se haya caído por una guarda. La
 * segunda es un defecto de la herramienta y la primera no, así que hace falta
 * verlas separadas.
 *
 * Imprime, por clase, cada hallazgo con el texto de su bloque alrededor.
 *
 *   node tools/ver-hallazgos.js /ruta/al/curso --clases 13
 */

const scanner = require('../engine/course-scan');
const probe = require('../engine/media-probe');
const transcribe = require('../engine/transcribe');
const onset = require('../engine/vendor/audio-onset');
const decidir = require('../engine/decidir');
const speech = require('../engine/speech-edges');
const repasar = require('../engine/repasar');
const ollamaServer = require('../engine/ollama-server');
const ai = require('../engine/ai-local');

const root = process.argv[2];
const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
};

if (!root) {
    console.error('Falta la ruta. Uso: node tools/ver-hallazgos.js /ruta/al/curso --clases 13');
    process.exit(1);
}

const reloj = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

(async () => {
    const scan = scanner.scan(root);
    if (!scan.ok) { console.error(scan.error); process.exit(1); }

    const numeros = (arg('clases') || '').split(',').filter(Boolean).map(Number);
    const classes = scan.classes.filter(c =>
        c.processable && (!numeros.length || numeros.includes(c.classNumber)));
    await probe.probeClasses(classes);

    const arranque = await ollamaServer.ensure({ model: arg('modelo') || null });
    if (!arranque.cliente) { console.error(`No hay modelo: ${arranque.reason}`); process.exit(1); }
    const cliente = ai.cliente({ url: arranque.cliente.url, model: arranque.model });
    console.log(`modelo: ${arranque.model}\n`);

    for (const cls of classes) {
        const fps = cls.fps || 30;
        const transcript = await transcribe.transcribeClass({
            root: scan.root, sequenceName: cls.sequenceName, wavPath: cls.liveMixPath, fps
        });
        const info = cls.liveMixPath ? onset.wavInfo(cls.liveMixPath) : null;
        const wav = info ? { file: cls.liveMixPath, info } : null;
        const words = transcript.words;

        const salida = await decidir.decidirCortes({ cls, words, wav, ai: cliente });
        const review = salida.review;
        const blocks = salida.alignResult.blocks || [];

        console.log(`═══ clase ${cls.classNumber} · ${(review.findings || []).length} hallazgos ` +
            `· repaso: ${JSON.stringify(salida.alignResult.repaso || {})}\n`);

        for (const f of review.findings || []) {
            const enGuion = (review.blocks || []).find(b => b.n === f.bloque);
            const block = enGuion ? blocks.find(b => b.index === enGuion.index) : null;
            console.log(`  [${f.bloque}] ${f.tipo} · ${f.gravedad} · ${f.fuente}` +
                (f.corregido ? '  ✓ ARREGLADO' : (repasar.SE_ARREGLA.has(f.tipo) ? '  ✗ se sabe arreglar y no se pudo' : '  — no se arregla')));
            console.log(`      ${f.detalle}`);
            if (f.corregido) console.log(`      → ${f.corregido}`);
            if (block) {
                const dentro = speech.wordsInside(words, block.startSec, block.endSec);
                console.log(`      ${reloj(block.startSec)}→${reloj(block.endSec)} · ` +
                    `abre «${dentro.slice(0, 7).map(speech.textOf).join(' ')}»`);
                console.log(`      cierra «${dentro.slice(-7).map(speech.textOf).join(' ')}»` +
                    ` · ${repasar.quedaColgando(words, block) ? 'COLGANDO' : 'cierra frase'}` +
                    ` · ${repasar.abreEnFalso(words, block) ? 'ABRE EN FALSO' : 'abre bien'}`);
            }
            console.log('');
        }
    }

    ollamaServer.stop();
    process.exit(0);
})();
