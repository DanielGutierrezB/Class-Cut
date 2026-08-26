'use strict';
/**
 * voz.js — Dónde suena alguien en la clase, medido en la onda y a resolución de
 * sílaba.
 *
 * Existe porque los tiempos de Whisper no aguantan que se los mire de cerca. Con
 * `-ml 1 -sow` cada palabra es un segmento y los segmentos se pegan uno al otro,
 * así que el "final" de una palabra es el arranque de la que sigue y nadie midió
 * nunca dónde para el sonido. Medido sobre las trece clases del curso de
 * spec-driven: 3.735 palabras de 45.182 (8,3%) figuran durando CERO —cinco
 * seguidas en el mismo instante— y 1.205 (2,7%) duran más de segundo y medio.
 * Una cuenta de "3, 2, 1." que en el audio son 1,4 s figura ocupando 8,7.
 *
 * Lo que hace falta para arreglarlo es una sola cosa: saber en qué momentos hay
 * sonido y en cuáles no. Con eso, `retimeo` reparte las palabras sobre el sonido
 * que de verdad hay en vez de sobre el reloj.
 *
 * **Por qué no alcanza con `silencios.js`.** Ese busca aire muerto de dos
 * segundos para avisarle al editor, y recorta cada pausa en la primera palabra
 * que el transcript pone adentro — o sea que hereda el error que acá hay que
 * corregir: en la clase 1 la pausa del bloque 3 figura terminando en 253,66 (que
 * es donde el transcript cree que empieza la cuenta) cuando el micrófono no
 * registra nada hasta 261,00. Y su resolución es de 126 ms, que es más que
 * muchas palabras.
 *
 * **Por qué no alcanza con `audio-onset.alignWords`.** Ese mide los DOS BORDES de
 * cada tirada y deja lo de adentro como vino, que es justo donde está el
 * problema. Además busca el borde en una ventana alrededor de donde el
 * transcript pone la palabra, con un tope de 3,5 s: en la cuenta del bloque 3 el
 * arranque real estaba a 7,3 s y se quedó a mitad de camino, dentro del silencio.
 *
 * Cuesta 0,3 s por clase leyendo un Live-Mix de 724 MB: se lee de corrido en
 * pedazos grandes y se mira una muestra de cada cuatro, que para decidir si hay
 * voz o no sobra. El resultado son unos 3.200 tramos y 52 KB.
 */

const fs = require('fs');

const onset = require('./vendor/audio-onset');
const workspace = require('./workspace');

// 1: primera versión.
const VERSION = 1;

/**
 * Cada cuánto se decide si suena o no.
 *
 * 20 ms es la mitad de la sílaba más corta que se dice en una clase, así que el
 * arranque de una palabra queda ubicado dentro de su propio ataque. Bajarlo a 5
 * —lo que usa `audio-onset` para un borde suelto— cuadruplica el trabajo y el
 * mapa entero, y el reparto de `retimeo` no lo aprovecha: reparte proporciones,
 * no busca ataques.
 */
const HOP_SEC = 0.02;

/**
 * Una muestra de cada cuántas se mira dentro del hop.
 *
 * Con 48 kHz un hop son 960 cuadros; mirando uno de cada cuatro quedan 240 por
 * canal, de sobra para un RMS que solo tiene que separar voz de sala. Mirarlos
 * todos multiplica por cuatro el tiempo y mueve el umbral menos de un 1%.
 */
const MUESTREO = 4;

/** De a cuánto se lee el archivo. Grande a propósito: es una lectura de corrido. */
const PEDAZO_BYTES = 1 << 23;

/**
 * Un hueco más corto que esto no separa dos sonidos.
 *
 * Adentro de una vocal larga el nivel late y cae un hop por debajo del umbral.
 * Sin puentear, una palabra sola aparece partida en tres tramos y el reparto le
 * da el peso de tres. Con 40 ms se juntan esas caídas y siguen separadas las
 * sílabas de verdad, que en el material del curso están a 100 ms o más.
 */
const PUENTE_SEC = 0.04;

/**
 * Un sonido más corto que esto es un clic, no alguien hablando.
 *
 * En el silencio del bloque 3 hay un golpe de 20 ms a los 256,62 s. Contándolo
 * como voz, la primera palabra de la cuenta se iba a parar encima del golpe en
 * vez de encima del "tres".
 */
const MINIMO_SEC = 0.04;

/** Magnitud de una muestra, en [0, 1]. El mismo reparto de formatos que `waveform`. */
function muestra(buf, off, info) {
    if (info.format === 3 && info.bits === 32) return Math.abs(buf.readFloatLE(off));
    if (info.bits === 16) return Math.abs(buf.readInt16LE(off)) / 32768;
    if (info.bits === 24) {
        const v = buf[off] | (buf[off + 1] << 8) | ((buf[off + 2] << 24) >> 8);
        return Math.abs(v) / 8388608;
    }
    if (info.bits === 32) return Math.abs(buf.readInt32LE(off)) / 2147483648;
    if (info.bits === 8) return Math.abs(buf[off] - 128) / 128;
    return 0;
}

/**
 * El nivel de la clase entera, un valor cada `HOP_SEC`.
 *
 * Se lee de corrido y no saltando de a un hop como hace `waveform.peaks`: acá
 * hacen falta 125.000 puntos y no 3.000, y 125.000 saltos de disco tardan más
 * que leer el archivo entero.
 *
 * @returns {{env: Float32Array, hopSec: number, info: object}|null}
 */
function envolvente(wavPath) {
    const info = onset.wavInfo(wavPath);
    if (!info || !info.sampleRate || !info.channels) return null;

    const bytesPorMuestra = info.bits / 8;
    const cuadro = info.channels * bytesPorMuestra;
    const cuadrosPorHop = Math.max(1, Math.round(info.sampleRate * HOP_SEC));
    const bytesPorHop = cuadrosPorHop * cuadro;
    const hops = Math.floor(info.dataBytes / bytesPorHop);
    if (!hops) return null;

    const env = new Float32Array(hops);
    // El buffer cae en un número entero de hops para que ningún hop quede
    // partido entre dos lecturas.
    const buf = Buffer.alloc(Math.max(1, Math.floor(PEDAZO_BYTES / bytesPorHop)) * bytesPorHop);
    const fin = info.dataOffset + info.dataBytes;

    let fd = null;
    try {
        fd = fs.openSync(wavPath, 'r');
        let posicion = info.dataOffset;
        let h = 0;
        while (posicion < fin && h < hops) {
            const quiere = Math.min(buf.length, fin - posicion);
            const leido = fs.readSync(fd, buf, 0, quiere, posicion);
            if (leido <= 0) break;

            const cuantos = Math.floor(leido / bytesPorHop);
            for (let k = 0; k < cuantos && h < hops; k++, h++) {
                const base = k * bytesPorHop;
                let suma = 0;
                let n = 0;
                for (let f = 0; f < cuadrosPorHop; f += MUESTREO) {
                    const off = base + f * cuadro;
                    for (let c = 0; c < info.channels; c++) {
                        const v = muestra(buf, off + c * bytesPorMuestra, info);
                        suma += v * v;
                        n++;
                    }
                }
                env[h] = n ? Math.sqrt(suma / n) : 0;
            }
            posicion += cuantos * bytesPorHop;
        }
    } catch (e) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* nada */ } }
    }

    return { env, hopSec: HOP_SEC, info };
}

/**
 * Los tramos con sonido de una envolvente ya medida. Lógica pura: se prueba sin
 * tocar un WAV.
 *
 * @param {Float32Array|Array} env
 * @param {number} hopSec
 * @param {number} umbral
 * @returns {Array<[number, number]>} [[desdeSec, hastaSec], …]
 */
function tramosDe(env, hopSec, umbral) {
    const crudos = [];
    let desde = -1;
    for (let i = 0; i <= env.length; i++) {
        const suena = i < env.length && env[i] >= umbral;
        if (suena) {
            if (desde < 0) desde = i;
            continue;
        }
        if (desde < 0) continue;
        crudos.push([desde * hopSec, i * hopSec]);
        desde = -1;
    }

    const unidos = [];
    for (const tramo of crudos) {
        const previo = unidos[unidos.length - 1];
        if (previo && tramo[0] - previo[1] <= PUENTE_SEC) previo[1] = tramo[1];
        else unidos.push([tramo[0], tramo[1]]);
    }

    const redondo = n => Math.round(n * 100) / 100;
    return unidos
        .filter(([a, b]) => b - a >= MINIMO_SEC)
        .map(([a, b]) => [redondo(a), redondo(b)]);
}

/**
 * El mapa de voz de una clase, en tiempo de la grabación.
 *
 * El umbral sale de la clase entera y no de cada tramo: en un silencio de medio
 * minuto no hay contraste, y un umbral local se pega al ruido de sala y toma
 * cualquier crujido por voz. Es la misma razón por la que `audio-onset` mira el
 * nivel de la clase para decidir si una palabra suelta suena.
 *
 * @returns {{version, hopSec, umbral, duracionSec, tramos}|null}
 */
function deLaClase(wavPath) {
    const medida = envolvente(wavPath);
    if (!medida) return null;

    const st = onset.stats(medida.env, {});
    // Sin contraste no hay nada que afirmar: o está todo callado o está todo
    // sonando, y en los dos casos un mapa de voz sería una invención.
    if (!(st.peak > st.floor * 3)) return null;

    return {
        version: VERSION,
        hopSec: medida.hopSec,
        umbral: st.threshold,
        duracionSec: Math.round(medida.info.durationSec * 100) / 100,
        tramos: tramosDe(medida.env, medida.hopSec, st.threshold)
    };
}

/**
 * El mapa de voz con su cache, igual que `silencios.asegurar`: sale del audio,
 * no cambia nunca mientras el archivo sea el mismo, y se pide en cada apertura
 * del visor.
 *
 * @param {object} params { root, sequenceName, wavPath }
 * @returns {object|null} null sin Live-Mix o si el audio no se pudo leer
 */
function asegurar(params) {
    const { root, sequenceName, wavPath } = params;
    if (!wavPath) return null;

    const artefacto = workspace.artifact(root, sequenceName, 'voz');
    const fuente = workspace.fingerprint(wavPath);
    const guardado = workspace.readJson(artefacto);
    if (guardado && guardado.version === VERSION && workspace.sameFingerprint(guardado.source, fuente)) {
        return guardado;
    }

    const mapa = deLaClase(wavPath);
    if (!mapa) return null;
    mapa.source = fuente;
    try {
        workspace.writeJson(artefacto, mapa);
    } catch (err) {
        // Que no se pueda escribir el cache no es motivo para no usarlo ahora.
    }
    return mapa;
}

module.exports = {
    deLaClase, asegurar, envolvente, tramosDe,
    VERSION, HOP_SEC, PUENTE_SEC, MINIMO_SEC
};
