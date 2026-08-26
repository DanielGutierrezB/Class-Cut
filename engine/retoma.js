'use strict';
/**
 * retoma.js — La misma explicación dos veces DENTRO de un mismo bloque.
 *
 * `repeticiones.js` busca la cabeza del bloque SIGUIENTE dentro del anterior:
 * retomas que cruzan el borde entre dos bloques. Cuando el CD marca el IN antes
 * del primer intento y el OUT después del segundo, las dos tomas quedan del
 * mismo lado del borde y ese detector no las puede ver — no hay bloque siguiente
 * con qué comparar. Es el bloque 3 de la clase 1 del curso: 41,2 s con el cambio
 * de paradigma de Spec-Driven Development explicado dos veces, y ninguna de las
 * cuentas del proyecto lo veía.
 *
 * Lo que la delata es que el profesor la anuncia en voz alta: "Pausa. Quiero
 * repetir esa. 3, 2, 1." La señal que se usa acá es la CUENTA y no la lista de
 * frases, por dos razones medidas sobre los 172 bloques del curso: está en 4 de
 * los 4 casos reales —el profesor no rehace una toma sin contar— y es lo único
 * que `speech-edges` ya sabe reconocer, así que no hay que inventar vocabulario
 * que después haya que mantener en dos sitios.
 *
 * Y la señal es imprescindible, no un adorno. Buscando repeticiones internas sin
 * pedirla —probando cada final de frase del bloque como si fuera un borde— salen
 * 11 bloques, y 7 son el profesor volviendo a nombrar algo que ya había
 * nombrado. El peor es el bloque 4 de la clase 7, que compara al 100 % ("nos
 * recomienda la opción A… también nos da una opción B") y son dos preguntas
 * distintas: hacerle caso tiraría 127 s de material único. Pidiendo la cuenta
 * quedan los 4 de verdad y ninguno de los 7.
 *
 * ## Qué toma se queda
 *
 * La cuenta es la tecla de borrar del profesor: marca dónde ARRANCA la toma que
 * quiere. Así que se queda la ÚLTIMA toma que se sostiene sola como bloque, y el
 * IN se abre justo después de su cuenta. En el curso eso acierta 4 de 4, y en el
 * bloque 9 de la clase 11 —tres tomas, dos cuentas adentro— es lo único que deja
 * la buena: haciéndole caso a la primera cuenta se conservaría la segunda toma,
 * que el profesor también rehizo.
 *
 * "Se sostiene sola" es la otra mitad de la regla, y sale de cómo se marca en
 * vivo. El CD puede haber puesto el OUT en medio de la toma nueva, y entonces lo
 * que hay después de la cuenta no es una toma: es su arranque, y el cuerpo vive
 * en el bloque siguiente. Ahí abrir el IN borraría la única versión completa que
 * existe, así que se hace lo contrario —el OUT retrocede hasta la cuenta y se va
 * el pedazo—. Ninguno de los 4 casos del curso tiene esa forma (las tomas que
 * quedan miden 12,2 s, 26,1 s, 4,7 s y 22,5 s, y las cuatro cierran su frase),
 * pero la forma sale de las cuatro maneras en que un par de marcadores puede
 * caer sobre dos tomas, no de una muestra, así que las dos ramas existen.
 */

const speech = require('./speech-edges');
const repeticiones = require('./repeticiones');
const borde = require('./borde');

const DEFAULTS = {
    fps: 30,
    // Lo que queda tiene que seguir siendo un bloque. Con menos que esto no hay
    // una toma del otro lado de la cuenta: hay el arranque de una.
    minimoQueQuedaSec: 3,
    // Y lo que se va tiene que valer mover el borde.
    minimoQueSeVaSec: 1.5
};

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

const dec = n => Math.round(n * 100) / 100;

/**
 * ¿Esta cuenta de acá adentro parte el bloque en dos tomas de lo mismo?
 *
 * @param {Array} dentro palabras del bloque
 * @param {{desde:number,hasta:number}} cuenta índices del conteo dentro de `dentro`
 */
function mirarLaCuenta(words, block, dentro, cuenta, options) {
    const antes = dentro.slice(0, cuenta.desde);
    const despues = dentro.slice(cuenta.hasta + 1);
    // Una cuenta pegada a una punta del bloque no es una retoma: es una sola
    // toma con la cuenta colgando, que es el defecto que `trimChatter` quita y
    // la medición cuenta como `conteo`. Mezclarlos sería mover un borde para
    // arreglar otra cosa.
    if (!antes.length || !despues.length) return null;

    const cuentaSec = dentro[cuenta.desde].start;
    const tomaSec = despues[0].start;

    // La confirmación de que son la misma explicación y no dos temas seguidos se
    // hace con el detector del borde entre bloques, tratando la cuenta como si
    // fuera ese borde. Es literalmente la misma pregunta —"¿lo de después vuelve
    // a decir lo de antes?"—, y contestarla con código propio sería tener dos
    // umbrales que con el tiempo se separan.
    const solape = repeticiones.solapeEntre(words,
        { index: block.index, startSec: block.startSec, endSec: cuentaSec },
        { index: block.index, startSec: tomaSec, endSec: block.endSec },
        options);
    if (!solape) return null;

    const base = {
        bloque: block.index,
        cuentaSec: dec(cuentaSec),
        tomaSec: dec(tomaSec),
        score: solape.score,
        parecido: solape.parecido,
        repiteDesdeSec: dec(solape.timeSec)
    };

    const quedaSec = block.endSec - tomaSec;
    const seVaSec = tomaSec - block.startSec;
    // La toma nueva se sostiene sola: se abre en ella y se va todo lo anterior.
    if (quedaSec >= opt(options, 'minimoQueQuedaSec')
        && seVaSec >= opt(options, 'minimoQueSeVaSec')
        && !speech.quedaColgando(words, tomaSec, block.endSec)) {
        return {
            ...base, accion: 'abrir', timeSec: tomaSec,
            seVaSec: dec(seVaSec), quedaSec: dec(quedaSec),
            texto: speech.textInside(words, block.startSec, cuentaSec)
        };
    }

    // No se sostiene: es el arranque de una toma que sigue más allá del OUT. La
    // buena es la de antes y lo que se va es el pedazo.
    const antesSec = cuentaSec - block.startSec;
    const colaSec = block.endSec - cuentaSec;
    if (antesSec >= opt(options, 'minimoQueQuedaSec') && colaSec >= opt(options, 'minimoQueSeVaSec')) {
        return {
            ...base, accion: 'recortar', timeSec: cuentaSec,
            seVaSec: dec(colaSec), quedaSec: dec(antesSec),
            texto: speech.textInside(words, cuentaSec, block.endSec)
        };
    }
    return null;
}

/**
 * La retoma interna de un bloque, con qué hacerle, o null.
 *
 * @returns {{bloque, accion, timeSec, cuentaSec, tomaSec, seVaSec, quedaSec, score, parecido, texto}|null}
 */
function buscarEnBloque(words, block, options) {
    if (!block || block.startSec == null || block.endSec == null) return null;
    const dentro = speech.wordsInside(words, block.startSec, block.endSec);
    const cuentas = speech.conteosEn(dentro);

    // De la última cuenta hacia atrás: gana la toma más nueva que se pueda
    // confirmar, que es la regla de arriba puesta en un bucle.
    for (let i = cuentas.length - 1; i >= 0; i--) {
        const hallazgo = mirarLaCuenta(words, block, dentro, cuentas[i], options);
        if (hallazgo) return hallazgo;
    }
    return null;
}

/** Las retomas internas de una clase. */
function buscar(words, blocks, options) {
    const hallados = [];
    for (const block of (blocks || []).filter(b => b.enabled !== false)) {
        const hallazgo = buscarEnBloque(words, block, options);
        if (hallazgo) hallados.push(hallazgo);
    }
    return hallados;
}

/**
 * Abre el bloque en la toma buena: mueve el IN y lo deja medido.
 */
function abrir(block, timeSec, params) {
    const { words, wav, options, reason } = params;
    if (!block.in) return null;

    // La cuenta queda afuera por construcción —el punto es la palabra que la
    // sigue—, pero puede haber quedado un "Ok." o un "Listo." del director
    // pegado al arranque de la toma, y eso se limpia con lo mismo que limpia
    // cualquier otro borde.
    const sinChatter = speech.trimChatter(words, timeSec, block.endSec, options);
    // Con suelo en el punto de la toma. `snapToSentence` retrae al principio de
    // la frase que el borde parte, y acá esa frase es la cuenta: sin suelo el
    // borde volvería justo adentro de lo que se está sacando.
    const enFrase = speech.snapToSentence(words, sinChatter.startSec, 'IN',
        { ...(options || {}), minTime: timeSec });
    // Hacia adelante sí, hacia atrás no: retroceder es volver a meter la toma
    // que se estaba tirando.
    const limpio = Math.max(timeSec, sinChatter.startSec, enFrase.timeSec);

    return borde.aplicar({
        block, kind: 'IN', timeSec: limpio, words, wav, options, decidedBy: 'retoma', reason
    });
}

/**
 * Mueve el borde y comprueba, con el deshacer incluido.
 *
 * Dos comprobaciones, y las dos aprendidas en el detector de repeticiones: que
 * la retoma ya no esté —mover el borde y dejarla es lo peor de los dos mundos— y
 * que no haya aparecido un defecto nuevo donde no había ninguno. Acá el defecto
 * nuevo que hay que vigilar depende de qué borde se movió: abriendo el IN, que
 * el bloque no arranque con una cuenta; recortando el OUT, que no quede
 * colgando.
 *
 * Lo que NO se comprueba es si la toma buena arranca con un conector huérfano.
 * Se probó pensarlo como los otros dos y no se sostiene: rechazar el arreglo por
 * un "Entonces" inicial deja adentro la explicación repetida entera, y treinta
 * segundos dichos dos veces son peor que una palabra que se apoya en algo que ya
 * no está.
 *
 * @returns {number|null} dónde quedó el borde, o null si se deshizo
 */
function aplicar(params) {
    const { block, hallazgo, words, wav, options } = params;
    const kind = hallazgo.accion === 'abrir' ? 'IN' : 'OUT';
    const colgabaAntes = speech.quedaColgando(words, block.startSec, block.endSec);
    const memoria = borde.recordar(block, kind);

    const porque = kind === 'IN'
        ? `el profesor rehace esta toma: se abre después de la cuenta de ${hallazgo.cuentaSec}s ` +
          `y se van ${hallazgo.seVaSec}s que ya decían esto mismo`
        : `lo que viene después de la cuenta de ${hallazgo.cuentaSec}s es el arranque de otra toma, ` +
          'no una toma: se cierra antes';

    const nuevo = kind === 'IN'
        ? abrir(block, hallazgo.timeSec, { words, wav, options, reason: porque })
        // El recorte del OUT ya existe y trae su limpieza a vueltas: el punto de
        // corte suele tener delante el "Pausa. Listo." con el que el profesor
        // paró, y eso se destapa en dos pasadas.
        : repeticiones.recortar(block, hallazgo.timeSec,
            { words, wav, options, decidedBy: 'retoma', reason: porque });
    if (nuevo == null) return null;

    const sigueRepitiendo = Boolean(buscarEnBloque(words, block, options));
    const abreConCuenta = kind === 'IN' && speech.abreConConteo(words, block.startSec);
    const cuelgaAhora = !colgabaAntes && speech.quedaColgando(words, block.startSec, block.endSec);
    if (sigueRepitiendo || abreConCuenta || cuelgaAhora) {
        borde.deshacer(memoria);
        return null;
    }
    return nuevo;
}

/**
 * Saca las retomas internas de una clase.
 *
 * Una pasada por bloque alcanza: `buscarEnBloque` se queda con la ÚLTIMA cuenta,
 * así que mover el borde ahí se lleva de una vez todas las tomas anteriores.
 *
 * @param {object} params { alignResult, words, wav, options }
 */
function quitarRetomas(params) {
    const { alignResult, words, wav, options } = params;
    const blocks = alignResult.blocks || [];
    const stats = { encontradas: 0, abiertas: 0, recortadas: 0, deshechas: 0, segundos: 0 };
    const hallazgos = [];

    for (const block of blocks.filter(b => b.enabled !== false)) {
        const hallazgo = buscarEnBloque(words, block, options);
        if (!hallazgo) continue;
        stats.encontradas++;

        const antes = hallazgo.accion === 'abrir' ? block.startSec : block.endSec;
        const nuevo = aplicar({ block, hallazgo, words, wav, options });
        if (nuevo == null) {
            stats.deshechas++;
            hallazgos.push({ ...hallazgo, accion: 'no se pudo' });
            continue;
        }

        if (hallazgo.accion === 'abrir') stats.abiertas++; else stats.recortadas++;
        stats.segundos += Math.abs(nuevo - antes);
        hallazgos.push({ ...hallazgo, aplicado: true, aplicadoSec: nuevo });
    }

    stats.segundos = Math.round(stats.segundos * 10) / 10;
    alignResult.retomas = { stats, hallazgos };
    return alignResult.retomas;
}

module.exports = { buscar, buscarEnBloque, quitarRetomas, aplicar, abrir, DEFAULTS };
