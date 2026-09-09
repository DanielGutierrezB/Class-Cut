'use strict';
/**
 * golpe.js — Encontrar el aplauso de la claqueta en el audio que va entrando.
 *
 * Vive en el motor y no en la ventana, aunque la ventana sea la que abre el
 * micrófono. La razón es que acá se puede comprobar: el audio que se captura
 * pasa igual por el proceso principal para escribirse en el WAV, así que
 * detectar el golpe del mismo lado deja probar la regla contra el Live-Mix de una
 * clase de verdad (`tools/simular-grabacion.js`) en vez de contra la memoria de
 * cómo suena un aplauso. En la ventana quedó solo el medidor, que es adorno.
 *
 * **Solo la mitad de la decisión.** Un golpe en la mesa o una puerta cumplen
 * todo lo que se mira acá. La otra mitad la pone el texto: `grabacion.js`
 * transcribe alrededor y pide que se haya dicho "clase". Este archivo dice
 * "sonó algo corto y fuerte", no "esa fue la claqueta".
 */

/**
 * Cuánto más fuerte que el fondo tiene que ser para llamarlo golpe.
 *
 * Se compara contra el fondo de ESTA sala y no contra un número fijo: la sala de
 * grabación de un día no suena como la de otro, y con el aire acondicionado
 * prendido el fondo sube varios decibelios. Un aplauso de claqueta está muy por
 * encima de esto, así que se puede ser generoso: un falso positivo se corrige con
 * un clic y un aplauso perdido se paga leyendo la clase entera a mano.
 */
const VECES_SOBRE_EL_FONDO = 8;

/**
 * Y un piso absoluto, para que en una sala en silencio un crujido no dispare.
 *
 * Medido sobre las trece clases del curso: el aplauso de la claqueta llega entre
 * 0,24 y 0,34, y el transitorio más fuerte que NO es la claqueta en el primer
 * minuto anda por 0,15. El material está unos 18 dB por debajo de lo normal (es
 * lo que obligó a nivelar el reproductor), así que un piso pensado para audio de
 * nivel normal no lo dispara nunca: con 0,18 se perdía la claqueta de dos clases.
 *
 * Es la parte frágil de la regla, porque depende de la ganancia con la que se
 * grabó. Se deja generosa a propósito: quien decide de verdad es el texto de
 * alrededor (`grabacion.js` pide que se haya dicho "clase"), y un candidato de
 * más cuesta una transcripción de un segundo.
 */
const PICO_MINIMO = 0.12;

/**
 * Cuán parejo puede ser el pedazo y seguir siendo un golpe.
 *
 * Se mide comparando el máximo contra el promedio: un golpe tiene un máximo
 * enorme y un promedio bajo, porque dura unos milisegundos de los ochenta y pico
 * que trae el pedazo. Una vocal gritada suena todo el pedazo y los tiene
 * parecidos.
 *
 * Es el número que de verdad separa: en las trece clases el aplauso da entre
 * 0,041 y 0,048, y el mejor transitorio que no es la claqueta da 0,091. Con esto
 * y el piso de arriba, el PRIMER candidato de cada una de las trece es el aplauso
 * —se comprobó leyendo qué se dice alrededor: sale "Claqueta 7, clase 7" en las
 * trece—. En dos clases cae bastante después del marcador que puso el director de
 * contenido a mano, y ahí el que tiene razón es este: el marcador se aprieta
 * antes de que el profesor aplauda.
 */
const PARTE_PAREJA = 0.10;

/** Después de un golpe no se busca otro por un rato. */
const DESCANSO_MS = 3000;

/** Con cuánto fondo se arranca, antes de haber medido nada. */
const FONDO_INICIAL = 0.002;

/**
 * ¿Este pedazo fue un golpe?
 *
 * Pura: sin reloj y sin estado, para poder probarla con números escritos a mano.
 *
 * @param {number} pico el máximo del pedazo, de 0 a 1
 * @param {number} medio el promedio del valor absoluto, de 0 a 1
 * @param {number} fondo el fondo medido de esta sala
 */
function esGolpe(pico, medio, fondo) {
    if (pico < PICO_MINIMO) return false;
    if (pico < fondo * VECES_SOBRE_EL_FONDO) return false;
    if (medio > pico * PARTE_PAREJA) return false;
    return true;
}

/**
 * El máximo y el promedio de un pedazo de PCM de 16 bits.
 *
 * Se recorre entero y no de a saltos: el golpe puede durar tres milisegundos y
 * mirar una muestra de cada diez lo perdería la mayoría de las veces.
 */
function medir(pcm) {
    const muestras = new Int16Array(
        pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    let pico = 0;
    let suma = 0;
    for (let i = 0; i < muestras.length; i++) {
        const v = Math.abs(muestras[i]) / 32768;
        if (v > pico) pico = v;
        suma += v;
    }
    return { pico, medio: muestras.length ? suma / muestras.length : 0 };
}

/**
 * El buscador, que es lo único con memoria: el fondo de la sala y cuándo fue el
 * último golpe.
 */
function nuevo() {
    return {
        fondo: FONDO_INICIAL,
        // `null` y no 0: con 0, un aplauso en los tres primeros segundos del reloj
        // quedaba dentro del descanso de un golpe que no existió y se descartaba.
        // En vivo no se notaba porque el reloj es la hora del día y son billones
        // de milisegundos, pero la simulación cuenta desde el arranque del audio y
        // ahí una claqueta temprana se perdía.
        ultimoMs: null
    };
}

/**
 * Mete un pedazo y dice si ahí hubo un golpe.
 *
 * La hora la trae el pedazo y no la mira este archivo: es la posición en el
 * audio, que es lo que deja pasarle una clase grabada a toda velocidad
 * (`tools/simular-grabacion.js`) y que el golpe quede donde sonó y no donde
 * llegó.
 *
 * @param {object} buscador de `nuevo()`
 * @param {Buffer} pcm 16 bits
 * @param {number} ms la hora del día de ESTE pedazo
 * @returns {{golpe:boolean, ms:number|null, pico:number, fondo:number}}
 */
function mirar(buscador, pcm, ms) {
    const { pico, medio } = medir(pcm);
    const cuando = Number(ms);

    const descansado = buscador.ultimoMs == null || cuando - buscador.ultimoMs >= DESCANSO_MS;
    let golpe = false;
    if (descansado && esGolpe(pico, medio, buscador.fondo)) {
        golpe = true;
        buscador.ultimoMs = cuando;
    }

    // El fondo se actualiza con lo tranquilo y no con los golpes: si un aplauso
    // subiera el fondo, el segundo aplauso ya no destacaría contra él.
    if (pico < buscador.fondo * 4) {
        buscador.fondo = buscador.fondo * 0.95 + medio * 0.05;
    }

    return { golpe, ms: golpe ? cuando : null, pico, fondo: buscador.fondo };
}

module.exports = {
    VECES_SOBRE_EL_FONDO,
    PICO_MINIMO,
    PARTE_PAREJA,
    DESCANSO_MS,
    FONDO_INICIAL,
    esGolpe,
    medir,
    nuevo,
    mirar
};
