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
 * `--reloj crudo|onda|dtw` elige con qué tiempos DECIDE el motor, que es el A/B
 * grande del proyecto: los tres relojes dicen las mismas palabras en el mismo
 * orden y discrepan en cuándo se dijeron.
 *
 *   - `crudo`: los tiempos que guardó Whisper, corregidos contra la onda en los
 *     bordes de cada tirada (`audio-onset.alignWords`). Es lo que hay hoy.
 *   - `onda`: además, las palabras rotas repartidas sobre el sonido que de verdad
 *     hay (`engine/retimeo.js`). Alias viejo: `--retimeo`.
 *   - `dtw`: la alineación contra el espectrograma que calcula whisper.cpp
 *     (`engine/reloj.js`). Pide un transcript que la traiga.
 *
 * **Lo que dio, con las trece clases transcriptas de nuevo y las entradas
 * congeladas.** Los totales de acá abajo son de ANTES de que se arreglara el
 * conector huérfano y se agregara "abre partiendo una frase"
 * (`speech-edges.conectorSinPedir` y `abreAMitad`), y de antes de que ese último
 * dejara de contestarse con el reloj del transcript —sobre el curso decía 7 y son
 * 2—, así que no se comparan con una corrida de hoy: la vara tiene un defecto más
 * y cuenta otros dos distinto. Lo que sigue
 * valiendo es el orden entre los tres relojes, que es lo que estas cifras
 * decidieron. Midiendo cada plan con el reloj con el que se decidió: 24 defectos
 * de borde con `crudo`, 26 con `onda`, 21 con `dtw`. Y la vara que no depende del
 * reloj —cortes encima de alguien hablando, que lo dice la medición de onda al
 * colocar el borde— da 4, 6 y 1. Ganó el DTW y está cableado en `engine/reloj.js`.
 *
 * De paso, dos resultados negativos que conviene no volver a descubrir: la ventaja
 * que `onda` tenía sobre los transcripts sin DTW (28 contra 23) no se sostiene
 * sobre los nuevos, porque la mitad de lo que arreglaba eran tiradas amontonadas
 * que el DTW ya no amontona; y la primera versión del reloj del DTW, que cerraba
 * cada palabra donde arrancaba la siguiente, metía seis cortes encima de la voz por
 * cómo `speech-edges.wordLimits` usa el final de la palabra anterior.
 *
 * La primera corrida del A/B de `onda` dio que no y estaba mal contada: el defecto
 * que hundía la variante se medía con `airFrames`, que no dice dónde quedó el corte
 * sino cuánto se equivocaba el transcript. El historial está en la cabecera de
 * `engine/retimeo.js`.
 *
 * Ojo con medir mientras otro reprocesa el curso: los transcripts son la entrada
 * del A/B y si alguien rehace uno a mitad de camino los dos brazos dejan de
 * comparar lo mismo. Ya pasó, con la clase 1 rehecha con DTW entre un brazo y el
 * otro. Para una comparación que valga, conviene medir sobre una copia congelada
 * (carpetas de verdad y enlaces DUROS al material, que el escaneo pregunta
 * `isFile()` y un enlace simbólico contesta que no).
 *
 * Cada plan se mide con los TRES relojes, y eso no es adorno: los defectos se
 * cuentan mirando qué palabras caen dentro del bloque, así que cambiarle los
 * tiempos a las palabras cambia también la vara. Sin las tres columnas, una
 * variante puede "mejorar" nada más porque se la mide distinto.
 *
 *   node tools/medir-repaso.js /ruta/al/curso [--clases 1,4,10] [--sin-repaso] [--ia cursor]
 *                              [--reloj crudo|onda|dtw] [--volcar /tmp/x.json]
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
const reloj = require('../engine/reloj');
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
// Con qué reloj decide el motor. Es lo único que cambia entre los brazos del
// A/B: el transcript, el criterio y su semilla son los mismos.
const RELOJES = ['crudo', 'onda', 'dtw'];
const relojPedido = arg('reloj') || (process.argv.includes('--retimeo') ? 'onda' : 'crudo');
if (!RELOJES.includes(relojPedido)) {
    console.error(`--reloj tiene que ser uno de: ${RELOJES.join(', ')}`);
    process.exit(1);
}
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
    // La misma cuenta medida con cada reloj. Los defectos se cuentan mirando qué
    // palabras caen dentro del bloque, así que cambiar los tiempos cambia también
    // la vara: un brazo podría "mejorar" nada más porque se mide distinto. Con las
    // tres columnas eso se ve en vez de esconderse.
    const cortes = Object.fromEntries(RELOJES.map(r =>
        [r, Object.fromEntries(defectos.TIPOS.map(t => [t, 0]))]));
    const sinReloj = Object.fromEntries(RELOJES.map(r => [r, 0]));
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
        const relojes = {
            crudo: words,
            onda: mapa ? retimeo.retimear(words, mapa).palabras : null,
            dtw: reloj.traeDtw(words) ? reloj.deDtw(words).palabras : null
        };
        for (const r of RELOJES) if (!relojes[r]) sinReloj[r]++;
        // Un reloj que esta clase no puede armar no se sustituye en silencio por
        // otro: el brazo diría que midió trece clases cuando midió once, y la
        // comparación quedaría contando dos veces el reloj de siempre.
        if (!relojes[relojPedido]) {
            console.error(`clase ${cls.classNumber}: no se puede armar el reloj «${relojPedido}», se saltea`);
            continue;
        }
        const paraDecidir = relojes[relojPedido];

        // `reloj: 'crudo'` porque los relojes los arma esta herramienta, que es la
        // que elige el brazo: sin eso el motor le pondría el suyo encima y los tres
        // brazos medirían lo mismo.
        // `voz: mapa` para que el motor no lo vuelva a calcular del Live-Mix: es
        // el mismo mapa con el que se mide unas líneas abajo, así que los dos
        // brazos deciden y se miden con el mismo, que es de lo que se trata acá.
        const salida = await decidir.decidirCortes({
            cls, words: paraDecidir, reloj: 'crudo', wav, voz: mapa, ai: cliente,
            options: sinRepaso ? { repaso: 'no' } : null
        });

        const lectura = salida.review;
        const vivos = (salida.alignResult.blocks || []).filter(b => b.enabled !== false);
        bloques += vivos.length;
        const rep = salida.alignResult.repeticiones;
        if (rep) segundosQuitados += rep.stats.segundos || 0;

        // La vara principal es la del reloj con el que se decidió, que es la
        // única lectura coherente: preguntarle a un plan hecho con un reloj qué
        // dice el otro mezcla dos cosas. Las otras van al lado para poder separar
        // lo que mejoró el corte de lo que mejoró la medición.
        // Con el mapa de voz, que ya está calculado unas líneas arriba: "abre
        // partiendo una frase" lo necesita y sin él da cero por no haber mirado.
        const medido = defectos.contarClase(paraDecidir, salida.alignResult.blocks, mapa);
        const porReloj = {};
        for (const r of RELOJES) {
            if (!relojes[r]) continue;
            porReloj[r] = r === relojPedido
                ? medido.cuenta
                : defectos.contarClase(relojes[r], salida.alignResult.blocks, mapa).cuenta;
            for (const tipo of defectos.TIPOS) cortes[r][tipo] += porReloj[r][tipo];
        }
        if (detalle) {
            for (const e of medido.ejemplos) bordes.push(`  clase ${cls.classNumber} · bloque ${e.bloque} · ${e.tipo}: ${e.texto}`);
        }

        if (volcarEn) {
            volcado.push({
                clase: cls.classNumber,
                sequenceName: cls.sequenceName,
                defectos: medido.cuenta,
                // Y el mismo plan leído con cada reloj, para que la comparación
                // pueda mirar dos brazos con una vara sola.
                defectosPorReloj: porReloj,
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
        for (const f of (lectura && lectura.findings) || []) {
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
        const arreglados = ((lectura && lectura.findings) || []).filter(f => f.corregido).length;
        // Los fallos del modelo se dicen SIEMPRE que los haya: una clase con la
        // lectura caída muestra "0 encontradas" y se lee como una clase limpia,
        // que es exactamente lo contrario de lo que pasó.
        const fallos = (lectura && lectura.stats && lectura.stats.fallos) || 0;
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
    console.log(`\n  decidido con el reloj «${relojPedido}»`);
    for (const r of RELOJES) {
        console.log(`  medido con «${r}»${r === relojPedido ? ' (el que decidió)' : '               '}: ` +
            `${defectos.TIPOS.map(t => `${t}=${cortes[r][t]}`).join(' · ')} · TOTAL ${suma(cortes[r])}` +
            (sinReloj[r] ? `  ⚠ ${sinReloj[r]} clases no lo pudieron armar` : ''));
    }
    if (detalle && bordes.length) console.log(`\n${bordes.join('\n')}`);

    if (detalle && lineas.length) console.log(`\n${lineas.join('\n')}`);

    if (volcarEn) {
        fs.writeFileSync(volcarEn, JSON.stringify({
            reloj: relojPedido,
            modelo: arranque.model,
            clases: volcado
        }, null, 1));
        console.log(`\n  bordes volcados en ${volcarEn}`);
    }

    ia.parar();
    process.exit(0);
})();
