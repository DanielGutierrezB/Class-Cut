'use strict';
/**
 * silencios.js — Dónde la clase se queda callada dentro de un corte.
 *
 * El editor necesita ver esto porque el aire muerto no se nota leyendo el
 * transcript: el texto va corrido y el video tarda diez segundos de más en
 * llegar a la frase siguiente. Se siente como si el panel estuviera adelantado,
 * y en realidad lo que sobra es el silencio.
 *
 * No se detecta con los tiempos de Whisper. Whisper le cuelga el silencio que
 * sigue al FINAL de la última palabra dicha: en una clase, "Development" figura
 * durando de 250,49 a 261,92 y de esos once segundos se habla medio. Mirando
 * solo el transcript, el hueco no existe —no hay separación entre una palabra y
 * la siguiente— aunque el micrófono no haya registrado nada. Por eso acá se mira
 * el audio.
 *
 * El nivel de referencia se saca de la clase entera y no de cada bloque: si un
 * bloque estuviera callado de punta a punta, su propio máximo sería el del ruido
 * de fondo y quedaría "con volumen normal" comparado consigo mismo.
 */

const waveform = require('./waveform');
const workspace = require('./workspace');

/** Puntos por segundo al mirar un tramo de cerca. Con 20, un hueco se ubica a 0,05 s. */
const POR_SEGUNDO = 20;

/** Cuántos puntos alcanzan para saber cuán fuerte suena una clase entera. */
const PUNTOS_DE_REFERENCIA = 4000;

/**
 * Debajo de qué parte del nivel normal se considera que no suena nada.
 *
 * Se compara contra el percentil 90 y no contra el máximo: un golpe en la mesa o
 * un pico de saturación levantan el máximo y con él el umbral, y entonces habla
 * normal empieza a contar como silencio.
 */
const FRACCION = 0.10;

/** Una pausa más corta que esto es respirar o separar una idea, no aire muerto. */
const MINIMO_SEC = 2;

/**
 * Un ruidito más corto que esto no interrumpe una pausa.
 *
 * Un crujido de silla en mitad de un silencio de once segundos levanta un solo
 * punto por encima del umbral, y sin esto se informan dos pausas de ocho y de
 * dos donde el editor ve una sola.
 */
const PUENTE_SEC = 0.3;

function percentil(valores, p) {
    if (!valores.length) return 0;
    const ordenados = [...valores].sort((a, b) => a - b);
    return ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * p))];
}

/**
 * Cuán fuerte suena esta clase, para tener contra qué comparar.
 *
 * Devuelve también la duración: sale de la misma pasada por el archivo, y
 * pedirla aparte era leer el WAV una segunda vez para un solo número.
 *
 * @returns {{nivel:number, duracionSec:number}|null} null si no se pudo leer
 */
function referencia(wavPath) {
    const w = waveform.peaks(wavPath, PUNTOS_DE_REFERENCIA);
    if (!w || !w.peaks.length) return null;
    return { nivel: percentil(w.peaks, 0.9), duracionSec: w.durationSec || 0 };
}

/**
 * Los tramos callados dentro de un pedazo de la grabación.
 *
 * @param {string} wavPath el Live-Mix
 * @param {object} opciones {desdeSec, hastaSec, nivel, minimoSec, porSegundo}
 * @returns {Array} [{desdeSec, hastaSec, duracionSec}] en tiempo de la grabación
 */
function enTramo(wavPath, opciones) {
    const { desdeSec, hastaSec } = opciones || {};
    const minimo = (opciones && opciones.minimoSec) || MINIMO_SEC;
    const porSegundo = (opciones && opciones.porSegundo) || POR_SEGUNDO;
    const nivel = opciones && opciones.nivel;

    if (!(hastaSec > desdeSec) || !nivel) return [];

    const puntos = Math.round((hastaSec - desdeSec) * porSegundo);
    const w = waveform.peaks(wavPath, puntos, { fromSec: desdeSec, toSec: hastaSec });
    if (!w || !w.peaks.length) return [];

    // `peaks` recorta el pedido a los límites del archivo y reparte los puntos
    // dentro de ESE tramo, así que la duración real por punto sale de lo que
    // devolvió y no de lo que se pidió.
    const segundosPorPunto = (w.toSec - w.fromSec) / w.peaks.length;
    const umbral = nivel * FRACCION;

    // Primero todos los tramos callados, sin importar el largo: el mínimo se
    // aplica al final, porque dos pausas cortas unidas por un puente pueden
    // sumar una larga.
    const crudos = [];
    let arranque = -1;
    for (let i = 0; i <= w.peaks.length; i++) {
        const callado = i < w.peaks.length && w.peaks[i] < umbral;
        if (callado) {
            if (arranque < 0) arranque = i;
            continue;
        }
        if (arranque < 0) continue;
        crudos.push([w.fromSec + arranque * segundosPorPunto, w.fromSec + i * segundosPorPunto]);
        arranque = -1;
    }

    const unidos = [];
    for (const tramo of crudos) {
        const previo = unidos[unidos.length - 1];
        if (previo && tramo[0] - previo[1] <= PUENTE_SEC) previo[1] = tramo[1];
        else unidos.push(tramo);
    }

    const redondo = n => Math.round(n * 100) / 100;
    return unidos
        .filter(([desde, hasta]) => hasta - desde >= minimo)
        .map(([desde, hasta]) => ({
            desdeSec: redondo(desde),
            hastaSec: redondo(hasta),
            duracionSec: redondo(hasta - desde)
        }));
}

/**
 * Recorta cada pausa hasta donde alguien vuelve a hablar.
 *
 * El pico del audio no alcanza para saber si hay voz. El director habla desde
 * lejos del micrófono y en el Live-Mix eso mide igual que el silencio —máximo de
 * 0,0040 en los dos, mientras el profesor llega a 0,10—, así que "Cuando estés
 * listo, dame el claqueta 1, clase 1" se detecta como quince segundos de nada.
 * Whisper sí lo oye, y por eso el transcript decide.
 *
 * Se recorta en vez de descartar: la pausa del bloque 3 termina cuando arranca
 * la cuenta de "tres, dos, uno", y siguen siendo diez segundos de nada aunque
 * después alguien hable. Descartarla entera perdería lo que hay que ver.
 */
function hastaQueAlguienHabla(tramos, palabras, minimoSec) {
    if (!palabras || !palabras.length) return tramos;
    const minimo = minimoSec == null ? MINIMO_SEC : minimoSec;
    const redondo = n => Math.round(n * 100) / 100;

    let i = 0;
    return tramos.reduce((salida, t) => {
        while (i < palabras.length && palabras[i].start < t.desdeSec) i++;
        // La primera palabra que ARRANCA adentro corta la pausa ahí. Una que
        // solo la atraviesa no cuenta: Whisper le cuelga a la última palabra
        // dicha todo el silencio que sigue, y esa es justo la pausa a mostrar.
        const corte = i < palabras.length && palabras[i].start < t.hastaSec
            ? palabras[i].start
            : t.hastaSec;

        if (corte - t.desdeSec >= minimo) {
            salida.push({
                desdeSec: t.desdeSec,
                hastaSec: redondo(corte),
                duracionSec: redondo(corte - t.desdeSec)
            });
        }
        return salida;
    }, []);
}

/**
 * Todas las pausas de una clase, en tiempo de la grabación.
 *
 * Se mira la clase entera y no bloque por bloque a propósito: así el resultado
 * no depende del corte. El editor mueve un borde, saca un bloque y cambia una
 * vista veinte veces mientras revisa, y las pausas siguen valiendo — están
 * ancladas al material, que es lo único que no cambia nunca. Recalcular en cada
 * cambio serían 800 ms de disco por vuelta.
 *
 * @param {string} wavPath el Live-Mix de la clase
 * @param {object} [opciones] {minimoSec, palabras} las del transcript
 * @returns {{nivel:number, minimoSec:number, tramos:Array}}
 */
function deLaClase(wavPath, opciones) {
    const minimo = (opciones && opciones.minimoSec) || MINIMO_SEC;
    const ref = referencia(wavPath);
    if (!ref || !ref.nivel) return { nivel: 0, minimoSec: minimo, tramos: [] };
    if (!ref.duracionSec) return { nivel: ref.nivel, minimoSec: minimo, tramos: [] };

    const candidatas = enTramo(wavPath, {
        desdeSec: 0, hastaSec: ref.duracionSec, nivel: ref.nivel, minimoSec: minimo
    });

    return {
        nivel: Math.round(ref.nivel * 10000) / 10000,
        minimoSec: minimo,
        duracionSec: Math.round(ref.duracionSec * 100) / 100,
        tramos: hastaQueAlguienHabla(candidatas, opciones && opciones.palabras, minimo)
    };
}

/**
 * Las pausas de una clase, con el cache y su política de frescura en un solo
 * lugar.
 *
 * Leer el audio son 800 ms, así que el resultado se guarda como artefacto. Lo
 * escribían dos: la transcripción (que sabe cuándo las palabras cambiaron) y el
 * visor (que sabe cuándo el mínimo quedó viejo), cada uno con su mitad de la
 * política — y una política repartida es dos maneras de equivocarse.
 *
 * `rehacer` lo pasa quien acaba de re-transcribir: las pausas se recortan
 * contra las palabras, y con palabras nuevas el cache miente aunque el mínimo
 * coincida.
 *
 * @param {object} params { root, sequenceName, wavPath, palabras, rehacer }
 * @returns {object|null} lo mismo que `deLaClase`, o null sin Live-Mix
 */
function asegurar(params) {
    const { root, sequenceName, wavPath, palabras, rehacer } = params;
    if (!wavPath) return null;

    const artefacto = workspace.artifact(root, sequenceName, 'silencios');
    if (!rehacer) {
        const guardadas = workspace.readJson(artefacto);
        if (guardadas && guardadas.minimoSec === MINIMO_SEC) return guardadas;
    }

    const halladas = deLaClase(wavPath, { palabras });
    try {
        workspace.writeJson(artefacto, halladas);
    } catch (err) {
        // Que no se pueda escribir el cache no es motivo para no mostrarlas.
    }
    return halladas;
}

module.exports = {
    deLaClase, enTramo, referencia, hastaQueAlguienHabla, asegurar,
    POR_SEGUNDO, FRACCION, MINIMO_SEC, PUENTE_SEC
};
