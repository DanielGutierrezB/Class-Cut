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
 * El criterio sale de Ajustes, igual que en la app: esto mide el producto que
 * el editor tiene configurado, no una copia. Para el A/B entre proveedores
 * están `--ia local|cursor|anthropic` y `--modelo`.
 *
 * Con `--retimeo` el motor decide sobre las palabras corregidas contra la onda
 * (`engine/retimeo.js`) en vez de sobre las que guardó Whisper. Es el A/B que
 * decide si esa corrección —que hoy solo endereza el panel del visor— también
 * mejora los cortes. Corrido sobre el curso entero dio que no (30 → 32 defectos
 * de borde, 4 bloques mejor y 9 peor); el porqué está en la cabecera de
 * `engine/retimeo.js`. La bandera queda porque el resultado hay que poder
 * volver a sacarlo cuando se toque lo que lo explica.
 *
 * Cada plan se mide con los DOS relojes y `tools/comparar-bordes.js` pone las
 * cuatro celdas una al lado de la otra: los defectos se cuentan mirando qué
 * palabras caen dentro del bloque, así que cambiarle los tiempos a las palabras
 * cambia también la vara, y sin las cuatro celdas una variante puede "mejorar"
 * nada más porque se la mide distinto.
 *
 *   node tools/medir-repaso.js /ruta/al/curso [--clases 1,4,10] [--sin-repaso] [--ia cursor]
 *                              [--retimeo] [--volcar /tmp/x.json]
 */

const fs = require('fs');

const scanner = require('../engine/course-scan');
const probe = require('../engine/media-probe');
const transcribe = require('../engine/transcribe');
const onset = require('../engine/vendor/audio-onset');
const decidir = require('../engine/decidir');
const coherence = require('../engine/coherence');
const ia = require('../engine/ia');
const ajustes = require('../engine/ajustes');
const voz = require('../engine/voz');
const retimeo = require('../engine/retimeo');
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
// Decidir sobre los tiempos corregidos contra la onda en vez de sobre los de
// Whisper. Es lo único que cambia entre los dos brazos del A/B: el transcript,
// el criterio y su semilla son los mismos.
const conRetimeo = process.argv.includes('--retimeo');
// Dónde dejar los bordes de cada bloque para poder compararlos después. La
// tabla de defectos dice cuántos hay, no cuáles se movieron: un brazo que
// arregla tres bordes y rompe tres empata en el total y no es lo mismo que uno
// que no tocó nada.
const volcarEn = arg('volcar');

(async () => {
    const scan = scanner.scan(root);
    if (!scan.ok) { console.error(scan.error); process.exit(1); }

    const pedidas = arg('clases');
    const numeros = pedidas ? pedidas.split(',').map(Number) : null;
    const classes = scan.classes.filter(c =>
        c.processable && (!numeros || numeros.includes(c.classNumber)));
    if (!classes.length) { console.error('Ninguna clase para medir.'); process.exit(1); }
    await probe.probeClasses(classes);

    const config = ajustes.leer().ia;
    if (arg('ia')) config.proveedor = arg('ia');
    const arranque = await ia.armar({ model: arg('modelo') || null }, ajustes.sanear({ ia: config }).ia);
    if (!arranque.cliente) { console.error(`No hay criterio: ${arranque.reason}`); process.exit(1); }
    const cliente = arranque.cliente;
    console.log(`modelo: ${arranque.model} (${arranque.source || arranque.proveedor})\n`);

    const pendientes = Object.fromEntries(TIPOS.map(t => [t, 0]));
    const corregidos = Object.fromEntries(TIPOS.map(t => [t, 0]));
    const cortes = Object.fromEntries(defectos.TIPOS.map(t => [t, 0]));
    // La misma cuenta, medida con el otro reloj. Los defectos se cuentan mirando
    // qué palabras caen dentro del bloque, así que cambiar los tiempos cambia
    // también la vara: un brazo podría "mejorar" nada más porque se mide
    // distinto. Con las dos columnas eso se ve en vez de esconderse.
    const cortesOtro = Object.fromEntries(defectos.TIPOS.map(t => [t, 0]));
    const volcado = [];
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

        // El mapa de voz se calcula y no se pide con `voz.asegurar`: guardarlo
        // escribiría en el Backup, que es justo lo que esta herramienta promete
        // no hacer para poder correrse sobre un curso ya entregado. Cuesta 0,3 s
        // por clase y hace falta en los dos brazos, porque la segunda vara se
        // mide con los tiempos corregidos aunque el motor no los use.
        const mapa = cls.liveMixPath ? voz.deLaClase(cls.liveMixPath) : null;
        const alSonido = mapa ? retimeo.retimear(words, mapa).palabras : null;
        const paraDecidir = conRetimeo && alSonido ? alSonido : words;

        const salida = await decidir.decidirCortes({
            cls, words: paraDecidir, wav, ai: cliente,
            options: sinRepaso ? { repaso: 'no' } : null
        });

        const review = salida.review;
        const vivos = (salida.alignResult.blocks || []).filter(b => b.enabled !== false);
        bloques += vivos.length;
        const rep = salida.alignResult.repeticiones;
        if (rep) segundosQuitados += rep.stats.segundos || 0;

        // La vara principal es la del reloj con el que se decidió, que es la
        // única lectura coherente: preguntarle a un plan hecho con un reloj qué
        // dice el otro mezcla dos cosas. La otra va al lado para poder separar
        // lo que mejoró el corte de lo que mejoró la medición.
        const medido = defectos.contarClase(paraDecidir, salida.alignResult.blocks);
        for (const tipo of defectos.TIPOS) cortes[tipo] += medido.cuenta[tipo];
        const otro = alSonido
            ? defectos.contarClase(conRetimeo ? words : alSonido, salida.alignResult.blocks)
            : medido;
        for (const tipo of defectos.TIPOS) cortesOtro[tipo] += otro.cuenta[tipo];
        if (detalle) {
            for (const e of medido.ejemplos) bordes.push(`  clase ${cls.classNumber} · bloque ${e.bloque} · ${e.tipo}: ${e.texto}`);
        }

        if (volcarEn) {
            volcado.push({
                clase: cls.classNumber,
                sequenceName: cls.sequenceName,
                defectos: medido.cuenta,
                defectosOtroReloj: otro.cuenta,
                ejemplos: medido.ejemplos,
                bloques: (salida.alignResult.blocks || []).map(b => ({
                    index: b.index,
                    startSec: b.startSec,
                    endSec: b.endSec,
                    enabled: b.enabled !== false,
                    inPor: b.in ? b.in.decidedBy || null : null,
                    outPor: b.out ? b.out.decidedBy || null : null
                })),
                hallazgos: ((salida.review && salida.review.findings) || []).map(f => ({
                    bloque: f.bloque, tipo: f.tipo, gravedad: f.gravedad,
                    corregido: Boolean(f.corregido), detalle: f.detalle
                }))
            });
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
        // Los fallos del modelo se dicen SIEMPRE que los haya: una clase con la
        // lectura caída muestra "0 encontradas" y se lee como una clase limpia,
        // que es exactamente lo contrario de lo que pasó.
        const fallos = (review && review.stats && review.stats.fallos) || 0;
        console.log(`clase ${String(cls.classNumber).padStart(2)} · ${String(vivos.length).padStart(2)} bloques · ` +
            `${String(rp.quedaban || 0).padStart(2)} encontradas → ${String(quedan).padStart(2)} pendientes · ` +
            `${arreglados} arregladas${rp.relectura ? ' · releída' : ''}` +
            (fallos ? ` · ¡${fallos} llamadas fallaron!` : ''));
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
    const suma = tabla => defectos.TIPOS.reduce((n, t) => n + tabla[t], 0);
    console.log(`\n  decidido con: ${conRetimeo ? 'las palabras corregidas contra la onda' : 'las palabras de Whisper'}`);
    console.log(`  defectos de borde: ${defectos.TIPOS.map(t => `${t}=${cortes[t]}`).join(' · ')} · TOTAL ${suma(cortes)}`);
    console.log(`  medido con el otro reloj: ${defectos.TIPOS.map(t => `${t}=${cortesOtro[t]}`).join(' · ')} · TOTAL ${suma(cortesOtro)}`);
    if (detalle && bordes.length) console.log(`\n${bordes.join('\n')}`);

    if (detalle && lineas.length) console.log(`\n${lineas.join('\n')}`);

    if (volcarEn) {
        fs.writeFileSync(volcarEn, JSON.stringify({
            retimeo: conRetimeo,
            modelo: arranque.model,
            clases: volcado
        }, null, 1));
        console.log(`\n  bordes volcados en ${volcarEn}`);
    }

    ia.parar();
    process.exit(0);
})();
