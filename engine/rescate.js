'use strict';
/**
 * rescate.js — Lo que se oye en el arranque de un bloque y el transcript no dice.
 *
 * El editor abrió el corte de la clase 13 y lo primero que oyó fue «Tres, dos,
 * uno.». No es que el motor la dejara pasar: **la cuenta no está en el
 * transcript**, así que ninguna de las tres reglas que la sacan la puede ver
 * —`trimChatter` con `finDeConteo`, el filtro de candidatos, la medición— y el
 * panel de texto tampoco la alumbra. El defecto lo dice `verificar-corte.js`,
 * que transcribe el render y es lo único que la oye.
 *
 * Y no es un fallo de Whisper leyendo mal: es un fallo de Whisper leyendo la
 * clase ENTERA. Cortando ese pedazo y transcribiéndolo solo, la escribe perfecto.
 * Los cuatro bloques del curso donde el defecto estaba confirmado por render:
 *
 *   clase 03 bloque 13 → «Ok, ok. 3, 2, 1. En este punto vamos a parar…»
 *   clase 07 bloque  8 → «3, 2, 1. Ahora te invito a que nos dejes en la…»
 *   clase 12 bloque 19 → «3, 2, 1.»
 *   clase 13 bloque  1 → «3, 2, 1. Hoy saber bytecodear es una gran ventaja…»
 *
 * En la pasada larga las saltea porque la ventana de 30 s que le toca trae la
 * toma abandonada, el ensayo y la cuenta, y el modelo escribe la frase UNA vez:
 * en la clase 13 pone «Como hoy, saber va y codiar es» sobre el ensayo (118,3 a
 * 121,7) y salta a «una» en 130,5, con lo que entre medio —la cuenta y el
 * «Hoy saber bytecodear» de la toma buena— no queda ni una palabra.
 *
 * ## La firma: dónde mirar
 *
 * Lo que delata el agujero es la onda contra el texto: **dos o más tramos de voz
 * sostenida (`speech-edges.VOZ_MINIMA_SEC`) entre el IN del bloque y la primera
 * palabra que se apoya en el sonido, sin ninguna palabra encima**. Alguien habló
 * al micrófono y el transcript no tiene nada que decir de ese momento.
 *
 * **Por qué la ventana se cierra en la primera palabra APOYADA y no en la
 * primera palabra.** Porque la palabra con la que Whisper tapa el agujero suele
 * ser una que él mismo puso donde no suena nada: en el bloque 19 de la clase 12,
 * «Aquí» figura de 3600,86 a 3604,06 —3,2 s— y adentro de esos 3,2 s el
 * micrófono registró 0,10. Es el defecto que `retimeo.esRota` ya nombra, y
 * preguntando por la primera palabra a secas esa tapaba la cuenta que hay detrás
 * y el bloque no aparecía. La palabra de verdad de ese arranque es «el», en
 * 3610,18, y en medio hay cuatro tramos de sonido sin una sola palabra encima.
 *
 * **Y el listón no es una elección de gusto, la ventana es bimodal.** Medidas las
 * 170 ventanas del curso entregado: la mediana es 0,35 s y el percentil 90, 0,59
 * s —o sea que en 166 bloques la primera palabra apoyada empieza en cuanto abre
 * el bloque—, y después hay un salto a los cinco únicos casos de más de un
 * segundo: 9,65 · 8,41 · 7,32 · 3,77 y 3,42. Los cuatro primeros son este defecto
 * y disparan; el quinto (bloque 14 de la clase 2) tiene un solo tramo huérfano y
 * es el hueco de 3,34 s que ya está medido como pausa legítima del profesor
 * (`speech-edges.HUECO_MINIMO_SEC`). No hace falta ningún tope de ventana: no hay
 * nada en el medio que un tope pudiera separar.
 *
 * ## Por qué NO se relee todo lo que no tiene texto
 *
 * La pregunta obvia es por qué no transcribir de nuevo cada tramo de voz sin
 * palabra encima, y la respuesta está medida: en el curso hay **880 tramos de voz
 * sostenida sin palabra cerca, 474 segundos**, y la enorme mayoría son
 * respiraciones, crujidos de silla y el director hablando lejos del micrófono
 * —que es justo lo que el mapa de voz deja pasar y `voz.js` explica—. Meter eso
 * en el transcript ensuciaría el karaoke, los cortes y las mediciones con
 * palabras inventadas sobre ruido.
 *
 * Acotado al arranque de un bloque son **4 bloques de 170**, que es donde el
 * agujero cambia una decisión: el borde del bloque se decide con las palabras que
 * hay ahí, y si no hay ninguna se decide a ciegas.
 *
 * ## Y las palabras entran al transcript, no a una variable
 *
 * Podría alcanzar con usarlas para correr el borde y tirarlas. No alcanza, y por
 * eso no se hace así: el panel de texto seguiría empezando tarde —que es la mitad
 * de lo que el editor reportó—, la medición seguiría informando `conteo 0` en un
 * curso que tiene cuatro, y la próxima regla que quiera mirar ese arranque
 * tendría que volver a leer el audio. Con las palabras en el transcript guardado
 * las ve todo el mundo con lo que ya sabe hacer, y es la razón por la que esto
 * arregla los dos síntomas de una vez.
 *
 * Lo que se relee es el tramo que el transcript no explica —del primer tramo
 * huérfano hasta la primera palabra apoyada—, con un poco de audio de más a cada
 * lado para que el modelo tenga contexto, y **de lo que sale se queda lo que cae
 * antes de esa primera palabra apoyada**. Ahí termina el agujero: de la palabra
 * apoyada en adelante el transcript ya tiene su versión y reescribirla no es el
 * trabajo de esta regla. En el bloque 13 de la clase 3 se ve por qué importa: la
 * relectura del pedazo trae «Ok, ok. 3, 2, 1. En este punto vamos a», y ese
 * «punto» de la cola es el mismo «punto» que el transcript ya tiene 30 ms más allá.
 *
 * Contra eso está la única barandilla que hace falta: **una palabra igual a menos
 * de `juntasSec` de una que ya está no se agrega**. No alcanza con comparar el
 * texto y nada más —las dos tomas de una frase dicen las mismas palabras, y las
 * dos suenan de verdad—, así que se compara el texto Y el instante.
 *
 * **El reloj es el de todos.** Las palabras nuevas entran con los tiempos que les
 * dio Whisper sobre el pedazo, corridos al reloj de la clase, y con su `dtw`
 * —que es lo que `engine/reloj.js` va a usar para ubicarlas, igual que con las
 * demás—. No se les pone la marca `onset`, porque la onda no midió su ataque, y
 * ese campo significa exactamente eso; el reloj ya sabe qué hacer con un arranque
 * que nadie midió (va por DTW).
 *
 * Y con eso caen donde se oyen. En el bloque 1 de la clase 13, la cuenta releída
 * queda en 127,08 · 127,80 · 128,38 y el mapa de voz tiene sonido en 127,12 ·
 * 127,84 · 128,38: 40 ms, 40 ms y 0. La palabra que abre la clase, «Hoy», cae en
 * 129,24 contra los 129,20 del mapa.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('./paths');
const relojes = require('./reloj');
const speech = require('./speech-edges');
const transcribe = require('./transcribe');

const DEFAULTS = {
    // Cuántos tramos de sonido sin palabra encima hacen falta para releer.
    //
    // Dos, y no uno, porque con uno entran cosas que no son un agujero: el
    // bloque 2 de la clase 11 tiene un único tramo huérfano de 1,68 s que es el
    // profesor hablando ENCIMA del corte («…escribiendo test unitarios»), no un
    // tramo sin texto — el texto está, del otro lado del borde. Con dos, los
    // cuatro que quedan son los cuatro del defecto. Y no es un listón fino: los
    // cuatro tienen tres o cuatro tramos, así que pedir tres daría lo mismo.
    tramosMinimos: 2,
    // Cuánto audio de más se le da a Whisper a cada lado del agujero.
    //
    // Medio segundo, y **más contexto lee PEOR**, que es lo contrario de lo que
    // uno esperaría. Barrido sobre los cuatro bloques del curso, mirando si la
    // cuenta sale escrita de forma que `speech-edges.finDeConteo` la reconozca:
    //
    //   contexto   0,5s   1,5s    3s     5s     8s
    //   bloques      4/4   3/4    2/4    3/4    1/4
    //
    // Y los fallos dicen por qué. Con 3 s el bloque 13 de la clase 3 sale «321»
    // en un solo token, que no es ninguna de las palabras de conteo que el motor
    // conoce. Con 5 y 8 s el pedazo se traga el ensayo que hay delante —el bloque
    // 1 de la clase 13 pasa a «más de comer. Ok. Como más natural. Ok. Tres, dos,
    // uno…»— y la cuenta se va más allá de la octava palabra, que es hasta donde
    // se la busca (`speech-edges.MIRAR_CONTEO`). El pedazo corto no tiene con qué
    // divagar: es la cuenta y lo que sigue.
    //
    // También es la más barata: menos de un segundo de Whisper por bloque.
    contextoSec: 0.5,
    // Dos palabras iguales más juntas que esto son la misma palabra dicha una
    // vez, no dos veces. Es la barandilla contra el duplicado: en el bloque 13
    // de la clase 3 la relectura trae un «punto» a 30 ms del «punto» que el
    // transcript ya tenía, y meter los dos dejaría el guion tartamudeando.
    juntasSec: 0.4,
    language: null
};

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

const dec = n => Math.round(n * 100) / 100;
const dec3 = n => Math.round(n * 1000) / 1000;

/**
 * Con qué instante se ubica una palabra recién leída.
 *
 * El del DTW cuando lo trae, porque es el que `engine/reloj.js` le va a dar y
 * porque es el único de los dos que se midió contra el sonido; el crudo de
 * Whisper cuando no hay alineación, que es lo único que queda.
 */
function instante(palabra) {
    return palabra.dtw != null ? palabra.dtw - relojes.DESFASE_DTW_SEC : palabra.start;
}

/** ¿Se apoya esta palabra en algún tramo de sonido sostenido? */
function seApoya(palabra, tramos) {
    return tramos.some(([desde, hasta]) => hasta > palabra.start && desde < palabra.end);
}

/**
 * El agujero con el que abre un bloque, o null si no hay ninguno.
 *
 * @param {Array} words palabras de la clase, con el reloj con el que se decide
 * @param {object} block bloque del alineado
 * @param {object|null} voz mapa de voz de la clase (`engine/voz.js`)
 * @returns {{bloque, desdeSec, hastaSec, tramos, sonidoSec, hastaPalabra}|null}
 */
function buscarEnBloque(words, block, voz, options) {
    if (!block || block.startSec == null || block.endSec == null) return null;
    const tramos = speech.vozSostenida(voz, options && options.minimoSec);
    if (!tramos.length) return null;

    const lista = speech.spoken(words);
    // La primera palabra del bloque que se apoya en el sonido. Es el borde del
    // agujero: hasta ahí el transcript no puede afirmar nada.
    const apoyada = lista.find(w => w.end > block.startSec + 0.02 && seApoya(w, tramos));
    const hasta = Math.min(apoyada ? apoyada.start : block.endSec, block.endSec);
    if (!(hasta > block.startSec)) return null;

    const huerfanos = tramos.filter(([desde, hasta_]) =>
        hasta_ > block.startSec && desde < hasta
        && !lista.some(w => w.end > desde && w.start < hasta_));
    if (huerfanos.length < opt(options, 'tramosMinimos')) return null;

    // El pedazo se lee desde el primer sonido huérfano y no desde el IN del
    // bloque: entre los dos puede haber minutos de tomas abandonadas que el
    // transcript SÍ escribió, y releerlas las duplicaría. En la clase 13 son los
    // nueve segundos de ensayo, que el transcript trae como «Como hoy, saber va y
    // codiar es».
    const contexto = opt(options, 'contextoSec');
    const desdeSec = Math.max(huerfanos[0][0], 0);
    return {
        bloque: block.index,
        desdeSec: dec(desdeSec),
        hastaSec: dec(hasta),
        leeDesdeSec: dec(Math.max(0, desdeSec - contexto)),
        leeHastaSec: dec(hasta + contexto),
        tramos: huerfanos.length,
        sonidoSec: dec(huerfanos.reduce((n, [d, h]) => n + (h - d), 0)),
        hastaPalabra: apoyada ? speech.textOf(apoyada) : null
    };
}

/** Los agujeros de arranque de una clase. */
function buscar(words, blocks, voz, options) {
    const hallados = [];
    for (const block of (blocks || []).filter(b => b.enabled !== false)) {
        const hallazgo = buscarEnBloque(words, block, voz, options);
        if (hallazgo) hallados.push(hallazgo);
    }
    return hallados;
}

/**
 * Corta un pedazo del Live-Mix, ya como Whisper lo quiere.
 *
 * A 16 kHz mono, que es lo mismo que `transcribe.aTasaDeWhisper` prepara para la
 * clase entera y lo que `verificar-corte.js` le da al render: leer el original a
 * 48 kHz estéreo tarda cuatro veces más y sale igual.
 *
 * @returns {string|null} el WAV temporal, o null si no se pudo
 */
function cortar(wavPath, desdeSec, hastaSec) {
    const ffmpeg = paths.ffmpeg();
    if (!ffmpeg || !ffmpeg.path) return null;

    const destino = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-rescate-')), 'tramo.wav');
    const r = spawnSync(ffmpeg.path, [
        '-v', 'error', '-y', '-i', wavPath,
        '-ss', String(Math.max(0, desdeSec)), '-to', String(hastaSec),
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        destino
    ], { encoding: 'utf8' });

    if (r.status !== 0 || !fs.existsSync(destino)) return null;
    return destino;
}

function tirar(temporal) {
    if (!temporal) return;
    try { fs.rmSync(path.dirname(temporal), { recursive: true, force: true }); } catch (e) { /* da igual */ }
}

/**
 * Lo que se oye en un tramo suelto, en el reloj de la clase.
 *
 * @param {object} params { wavPath, desdeSec, hastaSec, language, signal, options }
 * @returns {Promise<Array>} palabras con `start`, `end`, `text` y `dtw`
 */
async function leerTramo(params) {
    const { wavPath, options } = params;
    const arranca = Math.max(0, params.desdeSec);
    const pedazo = cortar(wavPath, arranca, params.hastaSec);
    if (!pedazo) return null;

    // El idioma se pide y no se detecta. Con `auto`, whisper.cpp lo adivina sobre
    // el pedazo, y un pedazo de seis segundos que dice «3, 2, 1.» no tiene con qué
    // decidir: la clase entera ya lo resolvió y esa respuesta es la que vale.
    let leido;
    try {
        leido = await transcribe.runWhisper(pedazo, {
            language: params.language || opt(options, 'language') || undefined,
            signal: params.signal
        });
    } finally {
        tirar(pedazo);
    }

    // Al reloj de la clase, el mismo corrimiento para los tres tiempos. El `dtw`
    // se corre igual que el resto: es un instante del mismo pedazo de audio.
    return leido.words.map(w => ({
        ...w,
        start: dec3(w.start + arranca),
        end: dec3(w.end + arranca),
        ...(w.dtw != null ? { dtw: dec3(w.dtw + arranca) } : {})
    }));
}

function pelada(texto) {
    return String(texto == null ? '' : texto).toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Las palabras de la relectura que se quedan: las que caen en el agujero y no
 * repiten una que el transcript ya tenía ahí mismo.
 *
 * @returns {{nuevas: Array, fuera: number, repetidas: number}}
 */
function filtrar(palabras, nuevas, hallazgo, options) {
    const juntas = opt(options, 'juntasSec');
    const dentro = [];
    let fuera = 0;
    let repetidas = 0;

    for (const palabra of (nuevas || [])) {
        const texto = speech.textOf(palabra).trim();
        if (!texto) continue;
        const donde = instante(palabra);
        // El agujero termina en la primera palabra apoyada: de ahí en adelante el
        // transcript ya tiene su versión de lo que se dijo.
        if (donde < hallazgo.leeDesdeSec || donde >= hallazgo.hastaSec) { fuera++; continue; }
        const clave = pelada(texto);
        const yaEsta = palabras.some(w =>
            pelada(speech.textOf(w)) === clave && Math.abs(instante(w) - donde) <= juntas);
        if (yaEsta) { repetidas++; continue; }
        dentro.push(palabra);
    }
    return { nuevas: dentro, fuera, repetidas };
}

/**
 * Mezcla las palabras nuevas con las del transcript, en orden.
 *
 * **El orden va por el instante del DTW y no por el `start` guardado, y eso es lo
 * único delicado de todo el módulo.** El `start` de un transcript es la
 * contabilidad de segmentos de Whisper —cada palabra empieza donde termina la
 * anterior, sin que nadie mire el sonido— y en un tramo mal leído no dice dónde se
 * dijo nada: en la clase 13, «una gran ventaja competitiva» figura con `start` de
 * 121,41 a 131,88, o sea repartida ENCIMA de la cuenta, mientras su DTW la pone
 * toda entre 130,68 y 131,56. Mezclando por `start`, la cuenta caía en medio de
 * esas cuatro palabras y el guion salía diciendo «una gran ventaja 3, competitiva,
 * 2, 1.».
 *
 * Por el instante del DTW, en cambio, sale el orden en que se oye. Y de paso
 * arregla un caso que por `start` habría quedado al revés: en el bloque 19 de la
 * clase 12, el «Aquí» de la toma buena tiene `start` 3600,86 —nueve segundos
 * antes de la cuenta— y DTW 3610,14, o sea DESPUÉS. Con el orden del DTW el
 * bloque abre en «Aquí el cambio fundamental», que es lo que dice la nota del CD;
 * con el del `start` abriría en «el cambio fundamental».
 *
 * **De la palabra nueva se conserva el `dtw` y nada más: entra sin duración.**
 * Suena a pérdida y no lo es, porque el pedazo no trae ninguna medición de dónde
 * empieza ni de dónde termina cada palabra. whisper.cpp corre con `-ml 1 -sow`, o
 * sea una palabra por segmento y los segmentos pegados uno al otro: el `end` de
 * una palabra ES el `start` de la siguiente, y el `start` de la primera se come
 * todo el silencio que le dieron de contexto. Lo único que se midió contra el
 * sonido es el DTW. En la clase entera esos tiempos igual dicen algo porque
 * `audio-onset.alignWords` les mide los dos bordes de cada tirada; el pedazo no
 * pasa por ahí, así que no hay nada que conservar.
 *
 * **Y guardarlos costaba un defecto, medido.** Con el `end` del pedazo puesto, el
 * «1.» de la cuenta del bloque 8 de la clase 7 cerraba en 2079,42 y la palabra que
 * sigue —«Ahora», donde abre la toma— arrancaba en 2079,42: pegados, porque así
 * los entrega Whisper. `speech-edges.wordLimits` saca el piso del IN del final de
 * la palabra anterior, así que el piso quedaba ENCIMA del corte, los diez cuadros
 * de aire no tenían dónde caber y el bloque salió con el corte sobre la voz
 * —`mitadPalabra` de 0 a 1 en el curso—. Es el mismo defecto que `engine/reloj.js`
 * ya tiene documentado, por el que los finales del reloj salen del transcript y no
 * del arranque de la palabra siguiente. Sin duración, el piso queda en el instante
 * del DTW y el colchón entra: el corte se fue a 2079,00, con el sonido arrancando
 * en 2079,34.
 *
 * Así que el `start` sale de donde terminó la palabra de al lado —la misma
 * contabilidad con la que viene la clase entera, y con eso el array queda ordenado
 * por `start` además de por DTW, que es lo que `reloj.deDtw` necesita para agrupar
 * tiradas sin aplastar a las vecinas— y el `end`, del propio instante del DTW más
 * la resolución con la que el DTW habla. O sea: «acá se dijo esto y de su duración
 * no se sabe nada», que es lo mismo que el reloj hace con cualquier palabra cuyo
 * final caería antes de su arranque.
 *
 * El `end` NO puede quedarse en el `start`, aunque sea lo más parco: `deDtw` no
 * deja que ninguna palabra arranque después del final más tardío de su tirada, y
 * ese techo se saca de los `end`. Con el injerto cerrando en el `start` heredado
 * —que en un tramo mal leído está antes del agujero— el techo caía antes que la
 * cuenta y las palabras nuevas se aplastaban todas en el mismo instante.
 *
 * Un transcript sin DTW es el único caso en que esto no se puede hacer —no hay
 * otro sitio de donde sacar la posición—, así que ahí las palabras entran con los
 * tiempos crudos del pedazo, que es lo único que hay. Pasa cuando el modelo
 * empaquetado no tiene grilla de cabezas de atención conocida
 * (`transcribe.DTW_POR_MODELO`), que es el mismo caso en el que el reloj del panel
 * va por `engine/retimeo.js`.
 *
 * Lo que sí se pierde: si entre las dos palabras de al lado había un hueco
 * declarado, el injerto lo tapa y las dos tiradas se vuelven una, así que la que
 * abría la segunda deja de quedarse con el arranque que midió la onda y pasa a ir
 * por DTW. Es correcto que se tape —ahí no había una pausa, había una cuenta que
 * nadie había escrito— y en el curso la única vez que le toca a una palabra con
 * arranque medido es el «Aquí» del bloque 19 de la clase 12, que con la onda
 * figuraba en 3600,86 y con el DTW cae en 3610,00, donde de verdad se oye.
 *
 * No muta lo que entra: el transcript guardado lo leen después el anclaje y el panel.
 *
 * @returns {{palabras: Array, agregadas: number}}
 */
function mezclar(palabras, nuevas) {
    const entrada = palabras || [];
    if (!nuevas || !nuevas.length) return { palabras: entrada.slice(), agregadas: 0 };

    const orden = nuevas.slice().sort((a, b) => instante(a) - instante(b));
    const salida = [];
    let i = 0;
    let k = 0;
    while (i < entrada.length || k < orden.length) {
        const vaLaVieja = k >= orden.length
            || (i < entrada.length && instante(entrada[i]) <= instante(orden[k]));
        if (vaLaVieja) { salida.push(entrada[i++]); continue; }

        const previa = salida[salida.length - 1];
        const nueva = { ...orden[k++] };
        if (previa && nueva.dtw != null) {
            nueva.start = dec3(previa.end);
            nueva.end = dec3(Math.max(nueva.start, instante(nueva) + relojes.RESOLUCION_DTW_SEC));
        }
        salida.push(nueva);
    }
    return { palabras: salida, agregadas: orden.length };
}

/**
 * Relee los arranques de bloque que el transcript no explica y devuelve las
 * palabras de la clase con lo que se oyó adentro.
 *
 * Las palabras que entran y salen son las CRUDAS del transcript, sin reloj
 * puesto: quien llame vuelve a armar el reloj con la lista completa
 * (`reloj.paraDecidir`), que es lo único que deja a las nuevas medidas con la
 * misma vara que las demás. Los bloques, en cambio, llegan ya alineados: la firma
 * se mide contra el IN que el motor va a usar.
 *
 * @param {object} params
 *   crudas   palabras del transcript, tal como se guardaron
 *   words    las mismas con el reloj puesto, que es con lo que se mide la firma
 *   blocks   bloques del alineado
 *   wav      {file, info} del Live-Mix
 *   voz      mapa de voz de la clase
 * @returns {Promise<{palabras, hallazgos, stats}>}
 */
async function rescatar(params) {
    const { crudas, words, blocks, wav, voz, options, signal } = params;
    const stats = { encontrados: 0, releidos: 0, agregadas: 0, descartadas: 0, repetidas: 0, fallados: 0 };
    const hallazgos = [];
    let palabras = (crudas || []).slice();

    if (!wav || !wav.file || !voz) return { palabras, hallazgos, stats };

    for (const hallazgo of buscar(words, blocks, voz, options)) {
        stats.encontrados++;
        let leidas = null;
        try {
            leidas = await leerTramo({
                wavPath: wav.file,
                desdeSec: hallazgo.leeDesdeSec,
                hastaSec: hallazgo.leeHastaSec,
                language: params.language,
                options, signal
            });
        } catch (err) {
            if (err && err.code === 'cancelado') throw err;
            stats.fallados++;
            hallazgos.push({ ...hallazgo, accion: 'no se pudo', error: err ? err.message : 'sin motivo' });
            continue;
        }
        if (!leidas) {
            stats.fallados++;
            hallazgos.push({ ...hallazgo, accion: 'no se pudo', error: 'no se pudo cortar el pedazo' });
            continue;
        }

        const filtrado = filtrar(palabras, leidas, hallazgo, options);
        stats.descartadas += filtrado.fuera;
        stats.repetidas += filtrado.repetidas;
        if (!filtrado.nuevas.length) {
            hallazgos.push({ ...hallazgo, accion: 'nada que agregar', leidas: leidas.length });
            continue;
        }

        const mezclado = mezclar(palabras, filtrado.nuevas);
        palabras = mezclado.palabras;
        stats.releidos++;
        stats.agregadas += mezclado.agregadas;
        hallazgos.push({
            ...hallazgo,
            accion: 'releído',
            agregadas: mezclado.agregadas,
            texto: filtrado.nuevas.map(w => speech.textOf(w)).join(' ')
        });
        if (params.onProgress) params.onProgress({ hecho: stats.releidos, total: stats.encontrados });
    }

    return { palabras, hallazgos, stats };
}

module.exports = {
    buscar, buscarEnBloque, leerTramo, filtrar, mezclar, rescatar, instante, DEFAULTS
};
