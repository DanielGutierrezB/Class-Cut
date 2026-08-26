'use strict';
/**
 * rehacer-lote.js — El curso entero de cero, sin la app y sin frenarse.
 *
 * `tools/process-all.js` ya corre el pipeline sobre una carpeta, y para el uso
 * normal es el que hay que usar. Este existe para la otra situación, que se dio
 * tres veces en dos días: rehacer las trece clases DESDE LA TRANSCRIPCIÓN
 * después de tocar algo que cambia lo que Whisper entrega, y poder mirar cómo
 * va sin esperar las ocho horas. Tres cosas que `process-all.js` no hace:
 *
 *   1. **Escribe el avance a un archivo, clase por clase.** Una corrida de
 *      trece clases dura horas y el stdout de una terminal no se puede leer
 *      desde afuera mientras corre. Acá cada clase que termina deja su línea y
 *      sus defectos en el parte, que se puede ir leyendo con `tail -f`.
 *   2. **Una clase que falla no frena el lote.** El pipeline devuelve el error
 *      y sigue; lo que no puede pasar es que la clase 3 tumbe las diez que
 *      faltan, porque el costo de volver a empezar son horas de Whisper.
 *   3. **Mide los defectos de cada clase al terminarla**, con la misma
 *      definición que `medir-cortes.js` (`tools/defectos.js`), así el parte
 *      dice si la clase salió bien y no solo si salió.
 *
 * **Encadena el motor a mano en vez de llamar a `pipeline.processClass`, y eso
 * es deuda, no diseño.** Es una segunda copia del orden de las etapas, y dos
 * copias de un orden terminan diciendo cosas distintas. Está así porque el
 * pipeline se estaba editando mientras esto corría y no se lo podía tocar ni
 * depender de él. Vive entero en `unaClase()` para que el día que se pueda,
 * ese cuerpo se reemplace por la llamada y no haya que buscar los pedazos.
 *
 *   node tools/rehacer-lote.js "/ruta/al/curso" [--force] [--parte /tmp/x.txt]
 *                              [--clases 1,2,3] [--desde 7]
 */

const fs = require('fs');
const path = require('path');

const scanner = require('../engine/course-scan');
const probe = require('../engine/media-probe');
const transcribe = require('../engine/transcribe');
const decidir = require('../engine/decidir');
const cutplan = require('../engine/cutplan');
const exporter = require('../engine/export');
const workspace = require('../engine/workspace');
const estadoClase = require('../engine/estado-clase');
const onset = require('../engine/vendor/audio-onset');
const speech = require('../engine/speech-edges');
const voz = require('../engine/voz');
const ia = require('../engine/ia');
const defectos = require('./defectos');

function arg(nombre, porDefecto) {
    const i = process.argv.indexOf(nombre);
    return i === -1 ? porDefecto : process.argv[i + 1];
}

const root = process.argv[2];
const force = process.argv.includes('--force');
const parteEn = arg('--parte', '/tmp/cc-lote-13.txt');
const soloEstas = arg('--clases', null);
const desde = Number(arg('--desde', 0));

if (!root) {
    console.error('Uso: node tools/rehacer-lote.js "/ruta/al/curso" [--force] [--parte archivo]');
    process.exit(1);
}

/**
 * El parte que se lee desde afuera mientras esto corre.
 *
 * Se abre en modo `append` y se escribe con `appendFileSync`, no con un stream
 * con buffer: lo que importa es que la línea esté en el disco EN CUANTO la
 * clase termina, porque quien lo lee lo hace mientras el proceso sigue vivo. Un
 * buffer de 64 KB dejaría el archivo vacío durante las primeras cuatro horas.
 */
function parte(linea) {
    const texto = `${linea}\n`;
    process.stdout.write(texto);
    try { fs.appendFileSync(parteEn, texto); } catch (e) { /* el lote no se cae por el parte */ }
}

function hhmmss(ms) {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return (h ? `${h}h ` : '') + `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Una clase, de la transcripción al XML.
 *
 * Es `pipeline.processClass` copiado a mano; ver la cabecera del archivo. Las
 * dos diferencias con él, las dos a propósito:
 *   - no pasa `viewMap`, porque el default `{PV:0, R:1}` es el del curso;
 *   - no llama a `hidratar`, que con `force` no tiene nada que hacer: traer el
 *     trabajo guardado de otra corrida es justo lo que no se quiere acá.
 */
async function unaClase(scan, cls, cliente, modelo) {
    const desdeMs = Date.now();
    const avisos = [];

    const transcript = await transcribe.transcribeClass({
        root: scan.root,
        sequenceName: cls.sequenceName,
        wavPath: cls.liveMixPath,
        fps: cls.fps || 30,
        force,
        onProgress: p => process.stdout.write(`\r  transcribir ${p}%   `)
    });

    const info = onset.wavInfo(cls.liveMixPath);
    const decided = await decidir.decidirCortes({
        cls,
        words: transcript.words,
        wav: info ? { file: cls.liveMixPath, info } : null,
        ai: cliente,
        onStage: (etapa, i) => process.stdout.write(
            `\r  ${etapa}${i && i.percent != null ? ` ${i.percent}%` : ''}          `)
    });
    avisos.push(...decided.warnings);

    workspace.writeJson(workspace.artifact(scan.root, cls.sequenceName, 'align'), decided.alignResult);
    if (decided.review) {
        workspace.writeJson(workspace.artifact(scan.root, cls.sequenceName, 'coherence'), decided.review);
    }

    const plan = cutplan.buildCutplan({
        blocks: decided.alignResult.blocks,
        videos: cls.videos,
        audios: cls.audios,
        durationSec: cls.durationSec,
        fps: cls.fps || 30
    });
    avisos.push(...plan.warnings);

    const exported = exporter.exportClass({
        root: scan.root, cls, alignResult: decided.alignResult, cutplan: plan
    });

    const msProceso = Date.now() - desdeMs;
    const guardado = estadoClase.guardar({
        root: scan.root, cls,
        resumen: {
            modelo,
            datos: {
                bloques: plan.totals.kept,
                offsetSec: decided.alignResult.offset ? decided.alignResult.offset.appliedSec : null,
                msProceso,
                materialSec: cls.durationSec || null
            }
        }
    });
    if (!guardado.ok) avisos.push({ code: 'estado_no_guardado', message: guardado.error });

    return {
        transcript, plan, exported, msProceso, avisos,
        review: decided.review,
        // Con las palabras que el motor USÓ para decidir y no con las del
        // transcript: los defectos se cuentan mirando qué palabras caen dentro de
        // cada bloque, así que medir con otro reloj mide otra cosa. Y con el mapa
        // de voz, que el motor ya dejó en el Backup: "abre partiendo una frase"
        // lo necesita y sin él da cero por no haber mirado.
        cuenta: defectos.contarClase(decided.palabras, decided.alignResult.blocks,
            voz.asegurar({ root: scan.root, sequenceName: cls.sequenceName, wavPath: cls.liveMixPath }))
    };
}

(async () => {
    const scan = scanner.scan(root);
    if (!scan.ok) { console.error(scan.error); process.exit(1); }

    let clases = scan.classes.filter(c => c.processable);
    if (soloEstas) {
        const pedidas = soloEstas.split(',').map(Number);
        clases = clases.filter(c => pedidas.includes(c.classNumber));
    }
    if (desde) clases = clases.filter(c => c.classNumber >= desde);

    await probe.probeClasses(clases);

    const arranque = await ia.armar({});
    if (!arranque.cliente) { console.error(`No hay criterio: ${arranque.reason}`); process.exit(1); }

    const inicio = Date.now();
    parte(`\n═══ lote de ${clases.length} clases · ${force ? 'CON force' : 'sin force'} · ` +
        `${arranque.model} (${arranque.source || arranque.proveedor})`);
    parte(`═══ arrancó ${new Date().toISOString()}\n`);

    const hechas = [];
    const fallidas = [];

    try {
        for (const cls of clases) {
            const etiqueta = `clase ${String(cls.classNumber).padStart(2, '0')}`;
            process.stdout.write(`\n${etiqueta} · ${cls.sequenceName}\n`);
            try {
                const r = await unaClase(scan, cls, arranque.cliente, arranque.model);
                const c = r.cuenta.cuenta;
                // Un transcript reusado de antes de que esto se midiera no trae
                // el número; se saca de las palabras, que es de donde sale igual.
                const p = r.transcript.puntuacion || speech.densidadDeCierres(r.transcript.words);
                hechas.push({ cls, r });
                parte(`\r${etiqueta} ✓ ${hhmmss(r.msProceso)} · ${r.plan.totals.kept}/${r.plan.totals.segments} bloques · ` +
                    `${Math.round(r.plan.totals.keepSec / 60)}min de ${Math.round((cls.durationSec || 0) / 60)}min · ` +
                    `${r.transcript.wordCount} palabras · ${((p.ratio || 0) * 100).toFixed(1)}% cierran (pozo ${p.pozoSec}s)`);
                parte(`         defectos: claqueta ${c.claqueta} · chatter ${c.chatter} · conteo ${c.conteo} · ` +
                    `colgando ${c.colgando} · conector ${c.conector} · mitadPalabra ${c.mitadPalabra} · repetido ${c.repetido}`);
                for (const d of r.cuenta.ejemplos) parte(`           b${d.bloque} ${d.tipo}: ${d.texto}`);
                for (const w of r.avisos) parte(`           ⚠ ${w.code}: ${w.message}`);
            } catch (err) {
                // Anotarla y seguir. Lo que cuesta acá son las horas de Whisper
                // de las clases que faltan, no la que se cayó.
                fallidas.push({ cls, error: err.message });
                parte(`\r${etiqueta} ✗ FALLÓ: ${err.message}`);
            }
        }
    } finally {
        ia.parar();
    }

    parte(`\n═══ ${hechas.length}/${clases.length} clases en ${hhmmss(Date.now() - inicio)}`);
    for (const f of fallidas) parte(`═══ falló la ${f.cls.classNumber}: ${f.error}`);
    parte(`═══ terminó ${new Date().toISOString()}`);
    parte(`═══ XML en ${path.join(scan.root, 'The Cutter')}`);
})();
