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
 *
 * ## La toma que se corta y no vuelve
 *
 * La cuenta encuentra las retomas y se le escapa la otra forma del mismo
 * defecto: la toma que se cortó y NO se rehízo adentro del bloque. El bloque 1
 * de la clase 11 dura 93 s y a los 30 el profesor cierra su frase
 * —«…auditar el código versus nuestras especificaciones.»— y dice «Pausa.». Lo
 * que sigue son 62 segundos de sala: «Ah, bueno. Sí, sí. Pensé que si iba a
 * mostrar igual la pantalla. Bueno, en este punto ya la aplicación está
 * funcionando. Ah, ok, ok. Ok, Ah, bueno, no hay problema. Listo. Vamos a ver.»
 * La toma buena arranca con la cuenta de 115,7 s, que cae FUERA del bloque, así
 * que del otro lado de la charla no hay nada que comparar y la regla de arriba no
 * tiene con qué confirmar nada.
 *
 * La señal acá es otra y el motor ya la sabe leer: la orden al editor. `Pausa`,
 * `corte`, `alto` (`speech-edges.STRONG_CHATTER`) son palabras que nadie dice
 * como parte de la clase, y hasta ahora se las buscaba solo en los bordes del
 * bloque (`trimChatter`), donde ya no queda ninguna. Adentro quedan seis en todo
 * el curso, y hacen falta dos filtros para separar la que importa. Cada uno mata
 * casos distintos:
 *
 *   - **Viene sola, como su propia frase**: la palabra de antes cierra frase y
 *     ella también. Un aparte del director es un «Pausa.» suelto; una palabra en
 *     medio de una oración es la clase hablando. Esto descarta «Pausa el video,
 *     termina de leer el PROM» del bloque 14 de la clase 2 —que se lo dice al
 *     alumno— y los dos «el artefacto más alto que toca» de la clase 12. Es el
 *     mismo criterio que `isChatter` ya le aplica al vocabulario flojo.
 *   - **Detrás sigue habiendo habla de rodaje**: al menos otra palabra del
 *     director, suelta, en lo que queda del bloque. Es lo que distingue una pausa
 *     de verdad —el profesor para, respira y sigue con la clase— de una toma que
 *     se murió ahí. Descarta «…nos permite corregir eso. Pausa. Entonces, aquí
 *     mostramos pantalla.» del bloque 6 de la clase 1, donde cortar tiraría 6,5 s
 *     de material único, y «…adaptar a tu proyecto. Pausa. No dije exacto.» del
 *     bloque 10 de la clase 5.
 *
 * De las 6 órdenes internas del curso queda 1, y es la de verdad. La charla
 * suelta adentro de un bloque es rara por lo mismo: 18 palabras en 170 bloques y
 * 13.231 palabras, casi todas cifras de un conteo que sobró, y el bloque 1 de la
 * clase 11 es el único que tiene una orden fuerte suelta con más charla detrás.
 *
 * **Por qué esto no reabre la puerta que la cuenta cerró.** Aflojar la cuenta
 * —probar cada final de frase como si fuera un borde— daba 11 candidatos con 7
 * falsos positivos, que eran el profesor volviendo a nombrar algo a propósito.
 * Esto no afloja nada de eso: no busca repeticiones ni prueba bordes, pide una
 * palabra que nadie dice dando clase. Los 7 falsos positivos de entonces no
 * tienen ninguna.
 *
 * Y se queda la PRIMERA orden del bloque, al revés que con la cuenta. No es una
 * inconsistencia: la cuenta marca dónde ARRANCA la toma que el profesor quiere, y
 * la orden marca dónde se MURIÓ la que estaba haciendo. Con la cuenta interesa la
 * más nueva; con la orden, la más vieja, porque todo lo que viene después es la
 * charla.
 *
 * **La onda dice lo mismo, y sirve de comprobación.** Ese mismo bloque 1 de la
 * clase 11 es el peor del curso midiendo aire muerto (`engine/aire.js`): tiene un
 * hueco de 23,0 s a los 66 s y otro de 6,0 s a los 48 s, porque después de la
 * orden la sala habla suelto y en el medio no hay nadie. Son el mismo hecho visto
 * de dos formas —el transcript ve una orden, el mapa de voz ve la sala vacía—, y
 * recortar el OUT acá se lleva los dos huecos. Que dos mediciones independientes
 * señalen el mismo borde es la única confirmación disponible cuando el caso de
 * verdad es uno solo.
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
    minimoQueSeVaSec: 1.5,
    // Cuánta charla de rodaje hace falta DETRÁS de una orden al editor para creer
    // que la toma se murió ahí. Con cero, «Pausa. Entonces, aquí mostramos
    // pantalla.» contaría y se tirarían 6,5 s de clase; los números de los seis
    // casos del curso están en la cabecera.
    charlaDetrasMinima: 1
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
        senal: 'cuenta',
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
 * ¿Esta orden al editor de acá adentro es donde se murió la toma?
 *
 * Los dos filtros y sus números están en la cabecera. Devuelve siempre un
 * recorte del OUT: lo que hay detrás de la orden es la sala hablando, así que la
 * toma que se conserva es la de antes.
 *
 * @param {Array} dentro palabras del bloque
 * @param {number} i índice de la orden dentro de `dentro`
 */
function mirarLaOrden(words, block, dentro, i, options) {
    const orden = dentro[i];
    const previa = dentro[i - 1];
    const detras = dentro.slice(i + 1);
    if (!previa || !detras.length) return null;

    // Sola, como su propia frase: lo de antes cerró y ella cierra.
    if (!speech.endsSentence(previa) || !speech.endsSentence(orden)) return null;

    // Y detrás sigue la charla. El silencio de cada palabra se mide contra la
    // anterior de la propia cola, que es lo que `isChatter` necesita para saber
    // si viene suelta o es parte de una frase.
    const charla = detras.filter((w, j) =>
        speech.isChatter(w, j > 0 ? w.start - detras[j - 1].end : 999, options, detras[j + 1])).length;
    if (charla < opt(options, 'charlaDetrasMinima')) return null;

    const cortaSec = orden.start;
    const quedaSec = cortaSec - block.startSec;
    const seVaSec = block.endSec - cortaSec;
    if (quedaSec < opt(options, 'minimoQueQuedaSec')) return null;
    if (seVaSec < opt(options, 'minimoQueSeVaSec')) return null;
    // Y lo que queda tiene que cerrar. Si la toma se murió a mitad de frase,
    // recortar cambia un defecto por otro: es la misma comprobación que la rama
    // de arriba le hace a la toma nueva.
    if (speech.quedaColgando(words, block.startSec, cortaSec)) return null;

    return {
        bloque: block.index,
        senal: 'orden',
        accion: 'recortar',
        timeSec: cortaSec,
        ordenSec: dec(cortaSec),
        orden: speech.textOf(orden),
        charlaDetras: charla,
        seVaSec: dec(seVaSec),
        quedaSec: dec(quedaSec),
        texto: speech.textInside(words, cortaSec, block.endSec)
    };
}

/**
 * La retoma interna de un bloque, con qué hacerle, o null.
 *
 * @returns {{bloque, senal, accion, timeSec, seVaSec, quedaSec, texto, …}|null}
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

    // Y si no hay ninguna cuenta que lo explique, la otra forma: la toma que se
    // cortó y no volvió. Va después porque la cuenta trae la confirmación de que
    // lo de los dos lados es lo mismo, y esto trae una señal más flaca; cuando
    // las dos aparecen en el mismo bloque, manda la que puede probar más.
    for (let i = 1; i < dentro.length - 1; i++) {
        if (!speech.STRONG_CHATTER.test(speech.textOf(dentro[i]).trim())) continue;
        const hallazgo = mirarLaOrden(words, block, dentro, i, options);
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

    const porque = hallazgo.senal === 'orden'
        ? `la toma se corta acá: el profesor dice «${hallazgo.orden}» al editor y detrás quedan ` +
          `${hallazgo.seVaSec}s de charla de rodaje`
        : (kind === 'IN'
            ? `el profesor rehace esta toma: se abre después de la cuenta de ${hallazgo.cuentaSec}s ` +
              `y se van ${hallazgo.seVaSec}s que ya decían esto mismo`
            : `lo que viene después de la cuenta de ${hallazgo.cuentaSec}s es el arranque de otra toma, ` +
              'no una toma: se cierra antes');

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

module.exports = { buscar, buscarEnBloque, mirarLaOrden, quitarRetomas, aplicar, abrir, DEFAULTS };
