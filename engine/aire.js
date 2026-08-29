'use strict';
/**
 * aire.js — El aire muerto que quedó adentro de un bloque entregado.
 *
 * Un bloque puede tener trece segundos de nada en el medio y pasar las nueve
 * comprobaciones en verde: ninguna miraba cuánto hueco quedó ADENTRO. Estaba
 * anotado como agujero conocido en la cabecera de `tools/defectos.js`, y el curso
 * entregado es ese agujero pasando de verdad.
 *
 * ## El inventario, que es lo que decidió el diseño
 *
 * Filtrando las migas del mapa de voz (`speech-edges.VOZ_MINIMA_SEC`, que es la
 * corrección de medición sin la cual esto no encuentra nada), los 170 bloques
 * entregados tienen **catorce huecos de más de cinco segundos, 2,1 minutos**. Y
 * se parten solos por vista:
 *
 *   vista R  (pantalla): 66 bloques ·  8 huecos · 55,8 s
 *   vista PV (cámara)  : 104 bloques ·  6 huecos · 67,8 s
 *
 * **En pantalla el hueco es la clase.** El profesor está tipeando o esperando a
 * una herramienta y el alumno está mirando eso. Renderizados y transcriptos, los
 * tres más largos de los ocho suenan: el de 13,46 s de la clase 7 bloque 5, «Para»;
 * el de 5,60 s de la clase 10 bloque 4, «Yes.»; el de 5,52 s de la clase 5
 * bloque 4, «del proyecto.». Es material bueno y sacarlo rompería la clase. Los
 * ocho están además repartidos en ocho clases distintas, o sea que es cómo se
 * graba y no un accidente.
 *
 * **En cámara el hueco es una toma arruinada, las seis veces.** Los 6 caen en
 * cuatro bloques, y los cuatro son tomas que se abandonaron:
 *
 *   - clase 11 bloque 1 (23,0 s a los 66 s, y 6,0 s a los 48 s) — la toma se
 *     corta en «Ok. Ok. Listo.» y detrás queda la sala vacía. Lo saca `retoma.js`
 *     moviendo el OUT, y con eso se van los dos huecos.
 *   - clase 7 bloque 8 (15,9 s AL ABRIR) — el hueco suena «Bien, entonces ahora
 *     solamente para cerrar, ayúdame diciendo, te invito a que me dejes en la
 *     sección de comentarios esos cambios que te arrojó que no habías considerado
 *     inicialmente», lejos del micrófono; y lo que viene después del hueco suena
 *     «3, 2, 1. Ahora te invito a que nos dejes en la sección de comentarios esos
 *     cambios que te arrojó y te preguntó y que tú no habías considerado». Es LA
 *     MISMA FRASE dos veces con la cuenta en el medio: el bloque abre sobre la
 *     toma abandonada. Lo saca esta regla moviendo el IN.
 *   - clase 13 bloque 1 (9,1 s AL ABRIR) — el hueco suena «Como hoy, saber va a
 *     escodear, como un poquito más recorrer. Ok. Como más natural. Ok. Venga.»:
 *     el ensayo de la frase y la charla con el director. Lo saca esta regla.
 *   - clase 2 bloque 4 (6,9 s a los 8 s y 6,9 s a los 16 s) — renderizando el
 *     bloque entero suena «¿Recuerdas en la clase anterior que cuando hicimos una
 *     modificación… perdón, una modificación… una modificación, no se ve
 *     reflejando… ok… 3, 2, 1…»: tres arranques fallidos antes de la toma. Este
 *     es el único que queda sin arreglo, y por qué está abajo.
 *
 * ## Por qué esto mueve el IN y no corta el hueco de adentro
 *
 * Eran tres opciones —partir el bloque en dos, recortar el silencio, o avisar— y
 * el inventario las decide sin que haga falta elegir por gusto:
 *
 *   - **Recortar el silencio de adentro empeora el único caso que quedaría.** En
 *     la clase 2 bloque 4 el silencio no es el defecto: es lo que separa los tres
 *     arranques fallidos. Pegando los bordes, «cuando hicimos una modificación» y
 *     «perdón, una modificación» quedan una al lado de la otra y la repetición se
 *     vuelve audible, que es peor que el hueco.
 *   - **Partirlo en dos deja la elección igual sin hacer.** Los pedazos serían
 *     tres intentos de la misma frase; cuál es el bueno lo dice la cuenta de la
 *     toma, y la cuenta no está en el transcript (por eso `conteo` mide 0 en todo
 *     el curso). La máquina no tiene con qué elegir.
 *   - **Al abrir sí se puede, y sin ambigüedad**, porque no hay que elegir entre
 *     pedazos: lo que está antes del primer sonido sostenido no es la clase, y lo
 *     que está después es el bloque entero. Son 2 de los 14.
 *
 * Así que esta regla hace una cosa sola: si un bloque de cámara ABRE sobre aire
 * muerto, corre el IN hasta donde alguien empieza a hablar al micrófono. El resto
 * se mide y se avisa —`tools/defectos.js`, defecto `aire`— para que la próxima vez
 * que pase lo vea alguien, que era el pedido.
 *
 * ## Hasta dónde llega, medido
 *
 * **Se queda a un paso: el borde nuevo aterriza sobre la cuenta de la toma.** En
 * los dos bloques que esto mueve, entre el hueco y la clase hay un «3, 2, 1» —
 * clase 13 en 127,12, clase 7 en 2076,96— y el borde queda justo delante. La
 * cuenta ya estaba adentro del bloque entregado, así que mover el IN no la mete:
 * la deja al descubierto. Lo que se gana son los 9,1 y 15,9 s de ensayo y toma
 * abandonada que había delante.
 *
 * No se saca acá por dos razones medidas, no por falta de ganas:
 *
 *   - **El transcript no la tiene, y ahí está el arreglo de verdad.**
 *     `trimChatter` ya sabe quitar la cuenta del arranque de un bloque
 *     (`finDeConteo`), y en estos dos no puede porque Whisper no la escribió:
 *     entre «es» (121,65) y «una» (130,54) el transcript de la clase 13 no tiene
 *     una sola palabra. Renderizando ese pedazo suelto, Whisper SÍ la escribe
 *     —«Tres, dos, uno. Hoy saber bytecodear es…»—, así que la cuenta se oye y lo
 *     que falla es la transcripción de la clase entera. Por eso `conteo` mide 0 en
 *     el curso y `tools/verificar-corte.js` es lo único que las ve.
 *   - **En la onda casi se distingue, y ese «casi» es el problema.** La cuenta son
 *     tres golpes cortos con hueco. Midiendo los 169 arranques del curso en los
 *     3 s que siguen al primer sonido, la clase ocupa el 83% de mediana con
 *     huecos de 0,34 s, y solo 5 arranques bajan del 50% con un hueco de más de
 *     1,2 s. Escuchados los 5: cuatro son cuentas (clase 13 bloque 1, clase 7
 *     bloques 1 y 8, clase 3 bloque 13) y el quinto es el bloque 7 de la clase 3,
 *     que suena «quinta herramienta es SpecKit de GitHub. Esta herramienta es la
 *     que nos va a permitir…», o sea clase. Un listón que saque las cuatro se
 *     lleva ese bloque por delante, y borrar clase es peor que dejar una cuenta.
 *
 * Con esa cuenta —4 de 5— no se construye una regla que BORRA material: se anota
 * el número y se deja para cuando la cuenta esté en el transcript, que es donde el
 * motor ya sabe qué hacer con ella. La cuenta ya estaba adentro de los dos bloques
 * entregados, así que esto no la agrega; lo que hace es dejarla al descubierto, y
 * `verificar-corte` la marca en 0:00 del corte para que nadie la pase por alto.
 *
 * Va aparte de `align.js` porque el mapa de voz no está ahí: el alineado trabaja
 * con la onda cruda (`audio-onset`), que busca el borde del sonido en ±2 s
 * (`searchSec`) y descarta lo de más allá —con la toma a nueve segundos ni la
 * vio—, y este arreglo necesita el mapa de la clase entera. Y va aparte de
 * `retoma.js` porque son dos defectos que se tocan sin ser el mismo: ese saca
 * material que se dijo dos veces mirando el transcript, este saca material que no
 * es la clase mirando la onda.
 */
const speech = require('./speech-edges');
const borde = require('./borde');

/**
 * La vista de cámara sobre el profesor. En la de pantalla, el silencio de adentro
 * es la clase; el inventario de arriba tiene los ocho casos y tres renders.
 */
const VISTA_DEL_PROFESOR = 'PV';

const DEFAULTS = {
    fps: 30,
    minimoQueQuedaSec: 3,
    pisoSec: null
};

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

const dec = n => Math.round(n * 100) / 100;

/**
 * El aire muerto de un bloque, ya con la vista aplicada.
 *
 * **La vista solo perdona el silencio de ADENTRO, y esa distinción es la regla
 * entera dicha en una línea.** Lo que hace legítimo un hueco en un bloque de
 * pantalla es que el profesor esté trabajando y el alumno mirando: eso pasa
 * DURANTE la clase. Un bloque que abre sobre aire todavía no empezó, así que no
 * hay nada que mirar y la vista no cambia nada.
 *
 * En el curso entregado esto no mueve ningún número —ningún bloque de pantalla
 * abre con cinco segundos o más de aire; los dos que más se acercan son el 19 de
 * la clase 12 con 4,87 s y el 13 de la clase 3 con 4,69 s, los dos por debajo del
 * listón—, así que queda escrito sin evidencia de que haga falta. Se escribe así
 * igual porque la alternativa tampoco la tiene, y de las dos esta es la que no
 * deja pasar el peor caso posible: una clase que abre con quince segundos de nada
 * porque el bloque es de pantalla.
 *
 * @returns {Array|null} null cuando no hay mapa de voz y no se puede afirmar nada
 */
function huecos(block, voz, options) {
    if (!block || block.startSec == null || block.endSec == null) return null;
    const todos = speech.huecosDeAire(voz, block.startSec, block.endSec, options);
    if (!todos) return null;
    if (block.view && block.view !== VISTA_DEL_PROFESOR) return todos.filter(h => h.alAbrir);
    return todos;
}

/** El hueco con que abre el bloque, que es el único que esta regla mueve. */
function abreSobreAire(block, voz, options) {
    const todos = huecos(block, voz, options);
    if (!todos || !todos.length) return null;
    const primero = todos[0];
    if (!primero.alAbrir) return null;
    // Un bloque entero mudo no es un bloque que abre sobre aire: es un bloque sin
    // nada, y mover el IN no lo arregla. Se avisa, no se toca.
    if (primero.alCerrar) return null;
    return primero;
}

function buscarEnBloque(words, block, voz, options) {
    const medida = abreSobreAire(block, voz, options);
    if (!medida) return null;
    return {
        bloque: block.index,
        huecoSec: medida.largoSec,
        arranqueSec: medida.hastaSec,
        texto: speech.textInside(words, block.startSec, medida.hastaSec)
    };
}

function buscar(words, blocks, voz, options) {
    const hallados = [];
    for (const block of (blocks || []).filter(b => b.enabled !== false)) {
        const hallazgo = buscarEnBloque(words, block, voz, options);
        if (hallazgo) hallados.push(hallazgo);
    }
    return hallados;
}

function aplicar(params) {
    const { block, hallazgo, words, wav, voz, options } = params;
    if (!block.in) return null;

    let destino = hallazgo.arranqueSec;
    if (destino <= block.startSec) return null;
    if (block.endSec - destino < opt(options, 'minimoQueQuedaSec')) return null;

    // Lo que quede de charla de rodaje pegado al arranque se va con la regla que
    // ya existe para eso, en vez de duplicar el criterio acá.
    const sinChatter = speech.trimChatter(words, destino, block.endSec, options);
    destino = Math.max(destino, sinChatter.startSec);

    const memoria = borde.recordar(block, 'IN');
    const nuevo = borde.aplicar({
        block, kind: 'IN', timeSec: destino, words, wav, options,
        decidedBy: 'aire',
        reason: `el bloque abría ${hallazgo.huecoSec}s antes de que se hable al micrófono` +
            (hallazgo.texto ? ` («${hallazgo.texto.slice(0, 60)}» queda afuera)` : '') +
            `: se abre en ${dec(destino)}s`
    });
    if (nuevo == null) return null;

    // `borde.aplicar` puede aterrizar en otro lado del que se le pidió —evita
    // cortar una palabra, se pega al frame— así que las condiciones se
    // comprueban sobre lo que quedó, no sobre lo que se quiso.
    const piso = opt(options, 'pisoSec');
    const sigueAbriendoSobreAire = Boolean(abreSobreAire(block, voz, options));
    const cruzaLaClaqueta = piso != null && block.startSec < piso;
    if (sigueAbriendoSobreAire || cruzaLaClaqueta) {
        borde.deshacer(memoria);
        return null;
    }
    return nuevo;
}

function quitarAire(params) {
    const { alignResult, words, wav, voz, options } = params;
    const blocks = alignResult.blocks || [];
    const stats = { encontrados: 0, movidos: 0, deshechos: 0, segundos: 0 };
    const hallazgos = [];

    for (const block of blocks.filter(b => b.enabled !== false)) {
        const hallazgo = buscarEnBloque(words, block, voz, options);
        if (!hallazgo) continue;
        stats.encontrados++;

        const antes = block.startSec;
        const nuevo = aplicar({ block, hallazgo, words, wav, voz, options });
        if (nuevo == null) {
            stats.deshechos++;
            hallazgos.push({ ...hallazgo, accion: 'no se pudo' });
            continue;
        }
        stats.movidos++;
        stats.segundos += nuevo - antes;
        hallazgos.push({ ...hallazgo, aplicado: true, aplicadoSec: nuevo });
    }

    // Y el resto se avisa, que es la mitad del trabajo. Doce de los catorce
    // huecos del curso están en el medio del bloque y esta regla no los toca a
    // propósito; si además no se dijeran, el editor tendría que volver a
    // encontrarlos escuchando, que es de dónde salió este encargo.
    const quedan = [];
    for (const block of blocks.filter(b => b.enabled !== false)) {
        const restantes = huecos(block, voz, options);
        if (!restantes || !restantes.length) continue;
        quedan.push({
            bloque: block.index,
            huecos: restantes,
            totalSec: Math.round(restantes.reduce((n, h) => n + h.largoSec, 0) * 10) / 10,
            peor: restantes.reduce((a, h) => (h.largoSec > a.largoSec ? h : a))
        });
    }

    stats.segundos = Math.round(stats.segundos * 10) / 10;
    alignResult.aire = { stats, hallazgos, quedan };
    return alignResult.aire;
}

module.exports = {
    huecos, abreSobreAire, buscar, buscarEnBloque, aplicar, quitarAire,
    VISTA_DEL_PROFESOR, DEFAULTS
};
