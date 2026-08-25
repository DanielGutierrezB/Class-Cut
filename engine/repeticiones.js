'use strict';
/**
 * repeticiones.js — Lo mismo dicho dos veces, arreglado.
 *
 * El profesor arranca una idea, no le sale, y la vuelve a decir. El CD marca los
 * dos intentos porque marca en vivo y no va a parar la grabación para editar, y
 * al final de la clase el alumno escucha la misma frase dos veces seguidas.
 *
 * Esto ya se detectaba —la capa de sentido lo reportaba como "Se dice dos veces"
 * y proponía "eliminar el bloque 14"—, pero reportarlo es dejarle la tarea al
 * editor. Y es una tarea que la máquina puede hacer mejor: la respuesta está en
 * los tiempos de palabra, no en el criterio.
 *
 * El arreglo casi nunca es tirar un bloque. Los dos intentos rara vez son
 * idénticos: lo normal es que al bloque de antes le sobre la COLA, porque siguió
 * de largo hasta donde el profesor se trabó, y que el de después ya diga eso
 * mismo mejor. Recortar esa cola conserva todo y arregla el empalme; tirar el
 * bloque entero pierde lo que sí era único.
 *
 * Buscarlo tiene que ser difuso. Dos tomas de la misma frase no son el mismo
 * texto: "y es justamente ese el problema por el que ByCoin no escala" contra
 * "y justo ese es el problema por el que el Bitcoin no escala". Comparando
 * literal no se parecen; para el que mira la clase son lo mismo.
 */

const anchor = require('./vendor/marker-anchor');
const speech = require('./speech-edges');
const borde = require('./borde');

const DEFAULTS = {
    fps: 30,
    padFrames: 2,
    // Cuántas palabras del bloque siguiente se buscan en el anterior. Con menos
    // de esto cualquier muletilla compartida da positivo; con más, dos tomas que
    // divergen a mitad de frase dejan de reconocerse.
    palabrasDeCabeza: 10,
    // Dos tomas de lo mismo no coinciden palabra por palabra, así que el listón
    // va más bajo que el de un cue: el caso real del curso puntúa 0.71.
    scoreMinimo: 0.62,
    // Por debajo de esto no vale mover nada: es el final del bloque, no una
    // retoma.
    minimoRecorteSec: 1.5,
    // Y lo que queda del bloque tiene que seguir siendo un bloque. Si el recorte
    // se lo come casi entero, no le sobraba la cola: era todo él la toma mala.
    minimoQueQuedaSec: 3,
    // Cuánto de lo que DICE tienen que compartir para considerarlas la misma
    // toma, quitando el relleno del idioma.
    parecidoMinimo: 0.5,
    // Tirar un bloque entero pide más que recortarle la cola.
    parecidoParaTirar: 0.7,
    // Y por largo que parezca el calco, a partir de acá ya no es una arrancada en
    // falso: es demasiado material para que lo decida la máquina sola.
    maximoQueSeTiraSec: 30
};

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

// Las palabras que no distinguen nada: aparecen en cualquier frase en español y
// son las que hacen que dos frases distintas parezcan la misma.
const DE_RELLENO = new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'al', 'del',
    'de', 'a', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'entre', 'hasta', 'desde',
    'y', 'o', 'u', 'e', 'ni', 'que', 'qué', 'como', 'cómo', 'cuando', 'cuándo', 'donde', 'dónde',
    'es', 'son', 'ser', 'está', 'están', 'estar', 'hay', 'ha', 'he', 'va', 'vamos', 'van',
    'se', 'nos', 'me', 'te', 'le', 'les', 'su', 'sus', 'mi', 'tu', 'nuestro', 'nuestra',
    'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'aquel', 'aquello',
    'ya', 'muy', 'más', 'menos', 'también', 'tambien', 'pero', 'porque', 'si', 'sí', 'no',
    'ahora', 'luego', 'después', 'despues', 'entonces', 'así', 'asi', 'acá', 'aca', 'aquí', 'aqui',
    'todo', 'toda', 'todos', 'todas', 'cada', 'otro', 'otra', 'mismo', 'misma',
    'hacer', 'tiene', 'tienen', 'debe', 'deben', 'puede', 'pueden', 'eh', 'pausa'
]);

function pelar(texto) {
    return String(texto || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

/**
 * Cuánto se parecen dos tramos mirando SOLO lo que dice algo.
 *
 * El puntaje del alineador no alcanza para decidir esto. "El cuarto componente
 * es el de estructura y estilo de código" y "el quinto componente es el de
 * manejo de errores y validaciones" alinean a 0.71 —el mismo puntaje que dos
 * tomas de verdad— porque comparten todo el andamiaje y no comparten nada de lo
 * que importa. Quitando el relleno, la primera pareja comparte 1 de 5 palabras y
 * la segunda casi todas.
 *
 * @returns {number} fracción de las palabras con contenido del primero que están
 *   también en el segundo
 */
function seParecen(unTexto, otroTexto) {
    const unas = pelar(unTexto).filter(p => !DE_RELLENO.has(p));
    const otras = new Set(pelar(otroTexto).filter(p => !DE_RELLENO.has(p)));
    if (!unas.length || !otras.size) return 0;
    const juntas = unas.filter(p => otras.has(p)).length;
    return juntas / unas.length;
}

/**
 * ¿Dónde empieza, dentro de `previo`, lo que `siguiente` va a volver a decir?
 *
 * @returns {{timeSec, score, parecido, palabras}|null}
 */
function solapeEntre(words, previo, siguiente, options) {
    const dentro = speech.wordsInside(words, siguiente.startSec, siguiente.endSec);
    const cabeza = dentro.slice(0, opt(options, 'palabrasDeCabeza'));
    if (cabeza.length < 6) return null;

    const texto = cabeza.map(speech.textOf).join(' ');
    const todas = anchor.findMatches(words, texto, 'IN', {
        truncatedLen: 1,
        minScore: opt(options, 'scoreMinimo'),
        fps: opt(options, 'fps')
    });

    // El borde de abajo entra: que la coincidencia caiga justo donde empieza el
    // bloque no es un caso raro que descartar, es el caso en que el bloque ENTERO
    // es la toma que sobra. Con `>` estricto, las arrancadas en falso —las únicas
    // que hay que descartar— eran justo las que no se veían.
    const hits = todas.filter(h => h.time >= previo.startSec && h.time < previo.endSec);
    if (!hits.length) return null;

    // Recortar menos que esto no arregla nada: es el final del bloque, no una
    // retoma.
    const minimo = opt(options, 'minimoRecorteSec');
    const util = hits.filter(h => previo.endSec - h.time >= minimo);
    if (!util.length) return null;

    // De las que quedan, la que además DIGA lo mismo: alinear bien no alcanza.
    const medidas = util.map(h => ({
        hit: h,
        parecido: seParecen(texto, speech.textInside(words, h.time, previo.endSec))
    })).filter(m => m.parecido >= opt(options, 'parecidoMinimo'));
    if (!medidas.length) return null;

    // Gana la que más se parezca, y entre iguales la que mejor alinee.
    const mejor = medidas.reduce((a, b) => {
        if (b.parecido !== a.parecido) return b.parecido > a.parecido ? b : a;
        return b.hit.score > a.hit.score ? b : a;
    });

    return {
        timeSec: mejor.hit.time,
        score: mejor.hit.score,
        parecido: Math.round(mejor.parecido * 100) / 100,
        palabras: cabeza.length
    };
}

/**
 * Las repeticiones de una clase, cada una con qué hacerle.
 *
 * @returns {Array<{bloque, contra, accion, timeSec, recorteSec, score, texto}>}
 */
function buscar(words, blocks, options) {
    const hallados = [];
    const vivos = (blocks || []).filter(b => b.enabled !== false);

    for (let i = 0; i < vivos.length - 1; i++) {
        const previo = vivos[i];
        const siguiente = vivos[i + 1];
        if (previo.startSec == null || previo.endSec == null) continue;

        const solape = solapeEntre(words, previo, siguiente, options);
        if (!solape) continue;

        const recorteSec = previo.endSec - solape.timeSec;
        const quedaSec = solape.timeSec - previo.startSec;
        const texto = speech.textInside(words, solape.timeSec, previo.endSec);

        // Si al recortar no queda bloque, es que el bloque entero era la toma
        // mala: una arrancada en falso que el profesor rehízo enseguida. Ahí no
        // se recorta, se descarta, y para eso hace falta estar mucho más seguro,
        // porque equivocarse borra material en vez de recortarlo.
        const leSobraLaCola = quedaSec >= opt(options, 'minimoQueQuedaSec');
        if (!leSobraLaCola) {
            if (solape.parecido < opt(options, 'parecidoParaTirar')) continue;
            // La toma que sobrevive es la completa. Si el candidato a irse dura
            // más que la que lo repite, no es una arrancada en falso: es material
            // propio que alguien tendrá que mirar.
            const duraPrevio = previo.endSec - previo.startSec;
            const duraSiguiente = siguiente.endSec - siguiente.startSec;
            if (duraPrevio > duraSiguiente) continue;
            if (duraPrevio > opt(options, 'maximoQueSeTiraSec')) continue;
        }

        hallados.push({
            bloque: previo.index,
            contra: siguiente.index,
            accion: leSobraLaCola ? 'recortar' : 'descartar',
            timeSec: solape.timeSec,
            recorteSec: Math.round(recorteSec * 100) / 100,
            quedaSec: Math.round(quedaSec * 100) / 100,
            score: solape.score,
            parecido: solape.parecido,
            texto
        });
    }
    return hallados;
}

/**
 * Recorta de verdad: mueve el OUT del bloque y lo deja medido como cualquier
 * otro borde, con su colchón de aire y sin entrar en la palabra vecina.
 */
function recortar(block, timeSec, params) {
    const { words, wav, options } = params;
    if (!block.out) return null;

    // El punto donde arranca la repetición es dónde HAY que cortar, no dónde
    // queda bien cortar. Antes de ese punto suele haber quedado la parte en la
    // que el profesor se trabó: el "Pausa. Listo. 3, 2," del bloque 11 de la
    // clase 13, o media frase sin terminar. Se limpia con lo mismo que limpia
    // cualquier otro borde.
    //
    // Va en vueltas porque las dos limpiezas se destapan entre sí: sacar el
    // conteo deja el borde detrás de un "Pausa. Listo.", y ajustar a la frase
    // aterriza justo después de esa muletilla, que también cierra frase. Una
    // sola pasada de cada una deja el bloque 11 de la clase 13 terminando en
    // "Listo.".
    //
    // Y con más margen para retraer del que se le da a un borde normal. Ahí la
    // pregunta es si conviene mover el corte; acá lo que queda entre la última
    // frase cerrada y el punto de recorte YA se sabe que sobra, porque es la
    // parte en la que el profesor se estaba trabando. Con el margen de siempre,
    // el bloque 4 de la clase 10 terminaba en "y aquí ya nos abre nuestro": el
    // punto estaba a seis palabras y solo se miraban cuatro.
    const conMargen = { ...(options || {}), retractWords: 8, maxShiftSec: 6 };

    let limpio = timeSec;
    for (let vuelta = 0; vuelta < 3; vuelta++) {
        const sinChatter = speech.trimChatter(words, block.startSec, limpio, options);
        const enFrase = speech.snapToSentence(words, sinChatter.endSec, 'OUT', conMargen);
        // Hacia atrás sí, hacia adelante no: pasarse es volver a meter lo que se
        // estaba sacando.
        const siguiente = Math.min(limpio, enFrase.timeSec, sinChatter.endSec);
        if (siguiente >= limpio - 0.01) { limpio = siguiente; break; }
        limpio = siguiente;
    }

    return borde.aplicar({
        block, kind: 'OUT', timeSec: limpio, words, wav, options, decidedBy: 'repetido'
    });
}

/** ¿El bloque termina a mitad de frase? */
function colgando(words, block) {
    const dentro = speech.wordsInside(words, block.startSec, block.endSec);
    return Boolean(dentro.length) && !speech.endsSentence(dentro[dentro.length - 1]);
}

/**
 * Recorta y comprueba, con el deshacer incluido.
 *
 * Dos comprobaciones, no una. La obvia es que la repetición ya no esté: recortar
 * y dejarla es lo peor de los dos mundos, porque mueve el corte y encima no
 * arregla. La otra se aprendió midiendo: el punto donde arranca la retoma no
 * siempre tiene una frase cerrada cerca, y cuando no la tiene el recorte deja el
 * bloque terminando a mitad de idea. Cambiar una repetición por un final colgando
 * no es un arreglo, es un defecto por otro.
 *
 * @returns {number|null} dónde quedó el corte, o null si no se pudo
 */
function aplicarRecorte(params) {
    const { block, siguiente, timeSec, words, wav, options, exigencia } = params;
    const colgabaAntes = colgando(words, block);
    const memoria = borde.recordar(block, 'OUT');

    const nuevo = recortar(block, timeSec, { words, wav, options });
    if (nuevo == null) return null;

    const sigueRepitiendo = Boolean(solapeEntre(words, block, siguiente, exigencia || options));
    if (sigueRepitiendo || (!colgabaAntes && colgando(words, block))) {
        borde.deshacer(memoria);
        return null;
    }
    return nuevo;
}

/**
 * Saca las repeticiones de una clase.
 *
 * Después de recortar se vuelve a mirar: un recorte que no resuelve lo que decía
 * resolver es peor que no haberlo hecho, porque mueve el corte y encima deja la
 * repetición. Si al revisar sigue ahí, se deshace.
 *
 * @param {object} params { alignResult, words, wav, options }
 */
function quitarRepeticiones(params) {
    const { alignResult, words, wav, options } = params;
    const blocks = alignResult.blocks || [];
    const stats = { encontradas: 0, recortadas: 0, descartadas: 0, avisadas: 0, deshechas: 0, segundos: 0 };
    const aplicadas = [];

    for (const hallazgo of buscar(words, blocks, options)) {
        stats.encontradas++;

        const block = blocks.find(b => b.index === hallazgo.bloque);
        const siguiente = blocks.find(b => b.index === hallazgo.contra);
        if (!block || !siguiente) { stats.avisadas++; aplicadas.push(hallazgo); continue; }

        // Una arrancada en falso: el bloque entero es la toma que no salió y la
        // buena viene justo después. No se apaga solo porque lo diga el parecido,
        // se apaga porque además es CORTO —el que sobrevive es el largo— y porque
        // lo que dice cabe en el que queda. Apagar es reversible desde la
        // revisión; el bloque sigue en el plan con su marca.
        if (hallazgo.accion === 'descartar') {
            block.enabled = false;
            block.disabledBy = 'repetido';
            block.disabledReason = `Arranque en falso: el bloque ${siguiente.index + 1} lo vuelve a decir entero.`;
            stats.descartadas++;
            stats.segundos += block.endSec - block.startSec;
            aplicadas.push({ ...hallazgo, aplicado: true });
            continue;
        }

        const antes = block.endSec;
        const nuevo = aplicarRecorte({ block, siguiente, timeSec: hallazgo.timeSec, words, wav, options });
        if (nuevo == null) {
            stats.deshechas++;
            aplicadas.push({ ...hallazgo, accion: 'no se pudo' });
            continue;
        }

        stats.recortadas++;
        stats.segundos += antes - nuevo;
        aplicadas.push({ ...hallazgo, aplicado: true, aplicadoSec: nuevo });
    }

    stats.segundos = Math.round(stats.segundos * 10) / 10;
    alignResult.repeticiones = { stats, hallazgos: aplicadas };
    return alignResult.repeticiones;
}

/**
 * Lo que el modelo vio repetido y las reglas no.
 *
 * La detección de arriba pide un parecido alto porque trabaja sola y no puede
 * permitirse recortar de más. Cuando el modelo señala el mismo bloque, hay dos
 * señales independientes apuntando al mismo sitio y se puede bajar el listón:
 * ya no se trata de descubrir la repetición, sino de UBICAR una que alguien más
 * ya vio. Lo que no baja es la comprobación de después —si al recortar la
 * repetición sigue ahí, se deshace igual—, que es lo que evita que la herramienta
 * corte por creerle al modelo.
 *
 * El modelo nombra UN bloque, no una pareja, y no dice de qué lado está el otro.
 * Cuando escribe "el bloque 7 repite lo que ya se dijo" puede querer decir que
 * el 6 lo adelanta o que el 7 lo adelanta y el 8 lo repite. Se prueban los dos
 * lados: quedarse con uno dejaba la mitad de las repeticiones señaladas sin
 * tocar, que es exactamente lo que pasaba —de nueve que el modelo vio en el
 * curso, cero se arreglaban—.
 *
 * @param {object} params { alignResult, review, words, wav, options }
 * @returns {{corregidos: number}}
 */
function segunElModelo(params) {
    const { alignResult, review, words, wav, options } = params;
    if (!review || !review.findings) return { corregidos: 0 };

    const blocks = alignResult.blocks || [];
    const conMasManga = {
        ...(options || {}),
        scoreMinimo: 0.5,
        parecidoMinimo: 0.4
    };
    let corregidos = 0;

    /** Intenta la pareja (previo → siguiente), recortándole la cola al previo. */
    function probar(entradaPrevia, entradaSiguiente) {
        if (!entradaPrevia || !entradaSiguiente) return null;
        const previo = blocks.find(b => b.index === entradaPrevia.index);
        const siguiente = blocks.find(b => b.index === entradaSiguiente.index);
        if (!previo || !siguiente || previo.enabled === false || siguiente.enabled === false) return null;

        const solape = solapeEntre(words, previo, siguiente, conMasManga);
        if (!solape) return null;
        if (solape.timeSec - previo.startSec < opt(options, 'minimoQueQuedaSec')) return null;

        const antes = previo.endSec;
        // La comprobación no baja con el listón: es la que evita que la
        // herramienta corte solo por creerle al modelo.
        const nuevo = aplicarRecorte({
            block: previo, siguiente, timeSec: solape.timeSec,
            words, wav, options, exigencia: conMasManga
        });
        if (nuevo == null) return null;

        // El informe tiene que hablar de la clase que quedó, no de la que se leyó.
        entradaPrevia.endSec = nuevo;
        entradaPrevia.durationSec = Math.round((nuevo - entradaPrevia.startSec) * 100) / 100;
        entradaPrevia.text = speech.textInside(words, entradaPrevia.startSec, nuevo);

        return `Se recortaron ${Math.round((antes - nuevo) * 10) / 10}s del bloque ` +
            `${entradaPrevia.n}, que ya decía esto mismo.`;
    }

    for (const hallazgo of review.findings) {
        if (hallazgo.tipo !== 'repetido' || hallazgo.corregido) continue;

        const posicion = review.blocks.findIndex(b => b.n === hallazgo.bloque);
        if (posicion === -1) continue;

        const hecho = probar(review.blocks[posicion - 1], review.blocks[posicion])
            || probar(review.blocks[posicion], review.blocks[posicion + 1]);
        if (!hecho) continue;

        corregidos++;
        hallazgo.corregido = hecho;
    }

    if (corregidos && alignResult.repeticiones) {
        alignResult.repeticiones.stats.recortadas += corregidos;
        alignResult.repeticiones.stats.porElModelo = corregidos;
    }
    return { corregidos };
}

module.exports = { buscar, quitarRepeticiones, segunElModelo, solapeEntre, recortar, seParecen, DEFAULTS };
