'use strict';
/**
 * medir-repaso.js — ¿Cuánto de lo que no cierra queda sin arreglar?
 *
 * `medir-cortes.js` mide cada borde por separado: si termina en una orden al
 * editor, si queda colgando, si corta a mitad de palabra. Eso es la calidad del
 * corte. Esto mide otra cosa: la clase leída de corrido, que es lo único que el
 * alumno va a notar y donde aparecen los problemas que ningún borde tiene solo
 * —lo mismo dicho dos veces, un bloque que arranca apoyado en algo que se
 * eliminó, una idea que no cierra—.
 *
 * La vara es cuántos de esos hallazgos quedan PENDIENTES. Uno corregido no
 * cuenta: dejó de ser una tarea del editor, que es el objetivo.
 *
 * Reprocesa desde el transcript guardado y no escribe nada en el Backup: se
 * puede correr sobre un curso entregado sin tocarlo.
 *
 * Con `--sin-repaso` corre lo mismo sin arreglar nada. Como el modelo va con
 * semilla fija, las dos variantes comparten TODO hasta la primera lectura, así
 * que lo que cambie en los defectos de borde es del repaso y de nada más.
 *
 *   node tools/medir-repaso.js /ruta/al/curso [--clases 1,4,10] [--sin-repaso]
 */

const scanner = require('../engine/course-scan');
const probe = require('../engine/media-probe');
const transcribe = require('../engine/transcribe');
const onset = require('../engine/vendor/audio-onset');
const decidir = require('../engine/decidir');
const coherence = require('../engine/coherence');
const ollamaServer = require('../engine/ollama-server');
const ai = require('../engine/ai-local');
const defectos = require('./defectos');

const root = process.argv[2];
const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
};

if (!root) {
    console.error('Falta la ruta. Uso: node tools/medir-repaso.js /ruta/al/curso [--clases 1,4]');
    process.exit(1);
}

const TIPOS = ['repetido', 'empalme', 'conector', 'idea_colgando', 'orden', 'otro'];
const detalle = process.argv.includes('--detalle');
const sinRepaso = process.argv.includes('--sin-repaso');
// Los transcripts guardados son de antes de que se colapsaran los bucles de
// frase, y rehacerlos con Whisper para medir escribiría encima de los del editor.
// Con esto se les pasa la limpieza al vuelo: es lo mismo que saldría de
// reprocesar, porque el colapso no toca los tiempos —el bucle se lo queda la
// última palabra que sobrevive— y el resto del transcript no se mueve.
const limpiando = process.argv.includes('--limpiar');

(async () => {
    const scan = scanner.scan(root);
    if (!scan.ok) { console.error(scan.error); process.exit(1); }

    const pedidas = arg('clases');
    const numeros = pedidas ? pedidas.split(',').map(Number) : null;
    const classes = scan.classes.filter(c =>
        c.processable && (!numeros || numeros.includes(c.classNumber)));
    if (!classes.length) { console.error('Ninguna clase para medir.'); process.exit(1); }
    await probe.probeClasses(classes);

    const arranque = await ollamaServer.ensure({ model: arg('modelo') || null });
    if (!arranque.cliente) { console.error(`No hay modelo local: ${arranque.reason}`); process.exit(1); }
    const cliente = ai.cliente({ url: arranque.cliente.url, model: arranque.model });
    console.log(`modelo: ${arranque.model} (${arranque.source})\n`);

    const pendientes = Object.fromEntries(TIPOS.map(t => [t, 0]));
    const corregidos = Object.fromEntries(TIPOS.map(t => [t, 0]));
    const cortes = Object.fromEntries(defectos.TIPOS.map(t => [t, 0]));
    const lineas = [];
    const bordes = [];
    let bloques = 0;
    let segundosQuitados = 0;
    let antes = 0;
    let quitadasPorBucle = 0;
    const desde = Date.now();

    for (const cls of classes) {
        const fps = cls.fps || 30;
        const transcript = await transcribe.transcribeClass({
            root: scan.root, sequenceName: cls.sequenceName, wavPath: cls.liveMixPath, fps
        });
        const info = cls.liveMixPath ? onset.wavInfo(cls.liveMixPath) : null;
        const wav = info ? { file: cls.liveMixPath, info } : null;

        let words = transcript.words;
        if (limpiando) {
            const limpio = transcribe.collapseLoops(JSON.parse(JSON.stringify(words)));
            quitadasPorBucle += limpio.removed;
            words = limpio.words;
        }

        const salida = await decidir.decidirCortes({
            cls, words, wav, ai: cliente,
            options: sinRepaso ? { repaso: 'no' } : null
        });

        const review = salida.review;
        const vivos = (salida.alignResult.blocks || []).filter(b => b.enabled !== false);
        bloques += vivos.length;
        const rep = salida.alignResult.repeticiones;
        if (rep) segundosQuitados += rep.stats.segundos || 0;

        const medido = defectos.contarClase(words, salida.alignResult.blocks);
        for (const tipo of defectos.TIPOS) cortes[tipo] += medido.cuenta[tipo];
        if (detalle) {
            for (const e of medido.ejemplos) bordes.push(`  clase ${cls.classNumber} · bloque ${e.bloque} · ${e.tipo}: ${e.texto}`);
        }

        let quedan = 0;
        for (const f of (review && review.findings) || []) {
            const tipo = TIPOS.includes(f.tipo) ? f.tipo : 'otro';
            if (f.corregido) { corregidos[tipo]++; continue; }
            pendientes[tipo]++;
            quedan++;
            if (detalle) {
                lineas.push(`  clase ${cls.classNumber} · bloque ${f.bloque} · ${f.tipo} (${f.gravedad}, ${f.fuente})\n` +
                    `    ${f.detalle}${f.sugerencia ? `\n    → ${f.sugerencia}` : ''}`);
            }
        }
        // El repaso deja dicho cuántas cosas había ANTES de tocarlas. Con la
        // semilla fija esa primera lectura es la misma que daría el pipeline sin
        // repaso, así que la línea base y el resultado salen de la misma corrida
        // en vez de dos separadas por media hora de modelo.
        const rp = salida.alignResult.repaso || {};
        antes += rp.quedaban || 0;
        const arreglados = ((review && review.findings) || []).filter(f => f.corregido).length;
        console.log(`clase ${String(cls.classNumber).padStart(2)} · ${String(vivos.length).padStart(2)} bloques · ` +
            `${String(rp.quedaban || 0).padStart(2)} encontradas → ${String(quedan).padStart(2)} pendientes · ` +
            `${arreglados} arregladas${rp.relectura ? ' · releída' : ''}`);
    }

    const totalPend = TIPOS.reduce((n, t) => n + pendientes[t], 0);
    const totalCorr = TIPOS.reduce((n, t) => n + corregidos[t], 0);

    console.log(`\n${classes.length} clases · ${bloques} bloques · ${Math.round((Date.now() - desde) / 1000)}s\n`);
    console.log(`  ${'hallazgo'.padEnd(16)}${'pendientes'.padStart(12)}${'arreglados'.padStart(12)}`);
    for (const tipo of TIPOS) {
        if (!pendientes[tipo] && !corregidos[tipo]) continue;
        console.log(`  ${tipo.padEnd(16)}${String(pendientes[tipo]).padStart(12)}${String(corregidos[tipo]).padStart(12)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(16)}${String(totalPend).padStart(12)}${String(totalCorr).padStart(12)}`);
    console.log(`\n  la lectura encontró ${antes} · le quedan al editor ${totalPend}` +
        (antes ? ` (${Math.round((1 - totalPend / antes) * 100)}% menos)` : ''));
    console.log(`  ${segundosQuitados.toFixed(1)}s quitados por repetición`);
    if (limpiando) console.log(`  ${quitadasPorBucle} palabras quitadas por bucle de Whisper`);

    // Y la vara de siempre, para que arreglar el guion no pueda empeorar los
    // bordes sin que se vea.
    console.log(`\n  defectos de borde: ${defectos.TIPOS.map(t => `${t}=${cortes[t]}`).join(' · ')}`);
    if (detalle && bordes.length) console.log(`\n${bordes.join('\n')}`);

    if (detalle && lineas.length) console.log(`\n${lineas.join('\n')}`);

    ollamaServer.stop();
    process.exit(0);
})();
