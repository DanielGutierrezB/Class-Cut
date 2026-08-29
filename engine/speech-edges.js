'use strict';
/**
 * speech-edges.js — Dónde termina de verdad lo que hay que dejar.
 *
 * Un bloque bien cortado no es el que empieza y termina donde el CD puso la
 * marca: es el que empieza cuando arranca una idea y termina cuando esa idea
 * cierra. Entre una cosa y otra se cuela lo que el profesor le dice al editor
 * ("pausa", "corte", "ok") y los pedazos de la frase siguiente.
 *
 * Medido sobre los 174 bloques del curso antes de este módulo: 66 terminaban con
 * una palabra del director —"…con el Bytecoin. Pau—"— y 103 terminaban a mitad
 * de frase, con un fragmento colgando: "…que debes aprender. Igual,".
 *
 * Acá viven las tres reglas que arreglan eso sin preguntarle a nadie:
 *   1. Los límites de palabra, para que el colchón de aire no se coma la palabra
 *      de al lado (que es de donde salía el "Pau—").
 *   2. El recorte del habla del director en los bordes.
 *   3. El ajuste a frase: si el borde cae a mitad de una, se retrae a la
 *      puntuación anterior o se extiende a la siguiente.
 *
 * Lo que no se puede decidir con reglas —cuál de las dos opciones deja mejor la
 * clase— se lo lleva `cut-refine.js`.
 */

// Órdenes al editor. Estas se van siempre: nadie las dice como parte de la clase.
const STRONG_CHATTER = /^(pausa|pausita|corte|cortes|corta|cortale|córtale|cortala|córtala|alto|cut)[.,;:!?¡¿…"»]*$/i;

// Estas también son del director, pero existen dentro del habla normal ("ya está
// listo", "va a ser así"). Solo cuentan como orden si vienen sueltas, después de
// un silencio: ahí no son parte de la frase, son un aparte.
const WEAK_CHATTER = /^(ok|okay|okey|vale|listo|listos|perfecto|perfecta|dale|va|vamos|bien|bueno|gracias|eso|ya)[.,;:!?¡¿…"»]*$/i;

// El conteo con el que arranca cada toma, y las sobras del conteo siguiente.
const COUNT_WORD = /^(tres|dos|uno|3|2|1)[.,;:!?…"»]*$/i;

// En cifra es siempre el conteo: nadie dice "3" a mitad de clase, Whisper escribe
// el número hablado en letra. En letra, en cambio, es una palabra normal —"Uno de
// los problemas más comunes", "dos formas de hacerlo"— y solo es conteo si viene
// con otra al lado.
const COUNT_DIGIT = /^[321][.,;:!?…"»]*$/;

// Hasta dónde se busca el conteo desde el arranque del bloque. Con el "Ok." o el
// "Listo." del director delante, la cuenta empieza en la tercera o la cuarta;
// más allá de la octava ya no es el arranque de la toma, es la clase.
const MIRAR_CONTEO = 8;

const SENTENCE_END = /[.!?…]["»)]*$/;

// Con esto no se abre un bloque: son conectores que apuntan hacia atrás, a algo
// que se dijo antes, y si ese antes quedó fuera del corte el bloque abre en
// falso. Ojo con ampliar la lista: "ahora", "luego", "después" y "bueno"
// apuntan hacia adelante y abren perfecto ("Ahora quiero mostrarte un caso
// concreto"), así que meterlos cuenta como defecto lo que está bien.
const CONECTOR_HUERFANO = /^(entonces|pero|porque|además|ademas|también|tambien|igual|y|sin embargo|es decir|o sea|por eso|así que|asi que)$/i;

/** Una palabra sin la puntuación que la rodea, para poder compararla con otra. */
function pelada(word) {
    return textOf(word).trim()
        .replace(/^[¡¿"«(]+/, '')
        .replace(/[.,;:!?¡¿…"»)]+$/, '')
        .toLowerCase();
}

/**
 * ¿Con cuántas palabras de conector abre esto? 0 si no abre con ninguno.
 *
 * Hay que contarlas y no contestar sí o no porque cinco entradas de la lista
 * —«sin embargo», «es decir», «o sea», «por eso», «así que»— son DE DOS
 * PALABRAS, y la expresión se probaba contra UNA sola. Esa mitad de la regla no
 * podía coincidir nunca: ninguna de sus palabras sueltas —"sin", "o", "sea",
 * "así", "que"— está en la lista, así que preguntando de a una no aparecían.
 * Vivió así desde que se escribió y no lo notó nadie, que es lo que pasa con el
 * código que no puede correr.
 *
 * **Lo que apareció al arreglarlo, sobre los 170 bloques del curso**: 3 bloques
 * más, y los 3 los abrió así el CD —«Sin embargo, acá tenemos una situación» y
 * «Sin embargo, acá pasa una situación» en la clase 1, «Así que vamos
 * directamente» en la 12—, con el bloque anterior cerrando su frase y sonando
 * justo antes. O sea lo mismo que ya se había medido con los otros doce: el
 * renglón sigue en 0. Lo que cambia es que ahora la regla puede ver un «Sin
 * embargo» que el corte SÍ haya dejado huérfano; hasta acá no podía.
 *
 * @param {Array|object|string} palabras las primeras del bloque (o una sola)
 */
function largoDeConector(palabras) {
    const lista = Array.isArray(palabras) ? palabras : [palabras];
    const primera = pelada(lista[0]);
    if (!primera) return 0;
    // Las de dos se prueban primero: son las que de a una no se ven.
    if (lista.length > 1 && CONECTOR_HUERFANO.test(`${primera} ${pelada(lista[1])}`)) return 2;
    return CONECTOR_HUERFANO.test(primera) ? 1 : 0;
}

/** ¿Esto abre con uno de esos conectores que se apoyan en lo de antes? */
function esConector(palabras) {
    return largoDeConector(palabras) > 0;
}

/**
 * ¿Este bloque abre con un conector que el CD NO pidió?
 *
 * Esta es la pregunta, y no "¿abre con un conector?". Lo de arriba dice si la
 * palabra se apoya en algo de antes; lo que decide si eso es un DEFECTO es si el
 * corte lo causó, y para eso hay una señal directa: la frase con la que el CD
 * marcó el arranque del bloque. Si el conector es la primera palabra de esa
 * frase, el bloque abre ahí porque el director lo quiso.
 *
 * **Los números, sobre los 170 bloques del curso.** Los 15 bloques que abren con
 * un conector lo traen en la orden del CD: 15 de 15, palabra por palabra —«Y en
 * 4º tenemos los no objetivos», «Pero antes de abrir la terminal», «También nos
 * está dando una información m»—. Es la misma cosa que `coherence.js` ya había
 * medido por su lado (24 de 25) y la razón por la que la lectura del modelo no
 * avisa de ninguno: es la forma de hablar del profesor, no un corte mal puesto.
 *
 * Eran 12 hasta que `largoDeConector` empezó a mirar las dos primeras palabras y
 * aparecieron los 3 de dos —«Sin embargo, acá tenemos una situación», «Sin
 * embargo, acá pasa una situación», «Así que vamos directamente»—. Los 3 salieron
 * iguales a los 12: pedidos por el CD, con el bloque anterior cerrando su frase
 * justo antes. El renglón siguió en 0 y no se movió ningún corte.
 *
 * **Por qué NO sirve preguntar por el hueco hasta el bloque anterior**, que es lo
 * que hacía `tools/defectos.js` («si entre los dos se tiró material, el
 * antecedente se perdió»). Mide el hueco en el material GRABADO, y el alumno no
 * ve ese hueco: `cutplan.js` pega los bloques que sobreviven uno tras otro en la
 * línea de tiempo, así que el bloque anterior suena SIEMPRE justo antes, con
 * hueco cero. Un hueco grande en la grabación no significa "se tiró contenido":
 * en los 15 casos significa que el profesor paró y el director contó. Mirando qué
 * hay adentro de esos huecos —de 4,8 s a 299,1 s— no hay nada más que la pausa,
 * el chatter y las tomas abortadas de LA MISMA frase: en la clase 3 la frase «Y la
 * sexta herramienta no es una herramienta como tal» aparece tres veces en el
 * hueco antes de la toma que quedó. El antecedente nunca se perdió.
 *
 * **Y por qué el defecto no se arregla moviendo el corte**, medido con la tabla
 * entera sobre las entradas congeladas y con la onda de verdad
 * (`tools/variante-conector.js`):
 *
 *   - Correr el IN detrás del conector deja la clase PEOR: el total de defectos
 *     de borde va de 8 a 12 y los bloques que abren partiendo una frase de 2 a 6,
 *     abriendo en «por muy bien que hayamos…», «le damos speckit-implement…»,
 *     «tenemos la fuente de la verdad…». Ninguna cuenta veía eso hasta que existió
 *     `abreAMitad` —todas miraban el final del bloque—, y es la razón por la que
 *     este defecto se cuenta como se cuenta acá y no como "abre con un conector,
 *     punto".
 *   - Y encima casi no hace lo que dice: en 11 de los 15 el conector se sigue
 *     oyendo, porque `wordLimits` no deja que el corte pase del final que el
 *     transcript le da a la palabra de antes y en el reloj del DTW ese final cae
 *     antes del sonido. Está medido en `repasar.quitarElConector`.
 *   - Abrir el IN más atrás para tragarse el antecedente es imposible: lo que hay
 *     delante del conector es el conteo de la toma en los 15 casos. Medido, se
 *     lleva el conteo adentro en 11 bloques y el habla del director en 10, y el
 *     total va de 18 a 29.
 *
 * @param {Array|object|string} primeras las palabras con las que abre el bloque
 * @param {string} cueIn la frase con la que el CD marcó el IN
 */
function conectorSinPedir(primeras, cueIn) {
    const largo = largoDeConector(primeras);
    if (!largo) return false;
    const lista = Array.isArray(primeras) ? primeras : [primeras];
    const pedido = String(cueIn || '').trim().split(/\s+/);
    // Se comparan TODAS las palabras del conector, no la primera. Con «Sin
    // embargo» mirar solo el «Sin» daría por pedido un cue que abriera con «Sin
    // duda», que no es lo mismo ni se apoya en lo de antes.
    for (let i = 0; i < largo; i++) {
        if (pelada(pedido[i] || '') !== pelada(lista[i])) return true;
    }
    return false;
}

const DEFAULTS = {
    weakPauseSec: 0.35,   // silencio a partir del cual una palabra suelta es un aparte
    maxShiftSec: 4,       // cuánto puede moverse un borde para cerrar la frase
    retractWords: 4,      // cuántas palabras atrás se busca la puntuación al retraer
    minKeepSec: 1.5       // un bloque nunca queda más corto que esto por ajustar
};

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

function textOf(word) {
    if (!word) return '';
    // Una palabra suelta también vale. `coherence.js` trabaja sobre el texto del
    // guion y no sobre las palabras del transcript, así que pregunta por la
    // primera palabra como string: sin esto le contestaba '' y ningún conector
    // era un conector.
    if (typeof word === 'string') return word;
    const value = word.text != null ? word.text : word.word;
    return value == null ? '' : String(value);
}

/** Las palabras que de verdad se dijeron, con tiempos utilizables. */
function spoken(words) {
    return (words || []).filter(w =>
        w && typeof w.start === 'number' && typeof w.end === 'number' && textOf(w).trim());
}

function endsSentence(word) {
    return SENTENCE_END.test(textOf(word).trim());
}

/**
 * ¿Esta palabra es una orden al editor y no parte de la clase?
 * @param {object} word
 * @param {number} pauseBefore silencio que la precede, en segundos
 */
function isChatter(word, pauseBefore, options, vecina) {
    const text = textOf(word).trim();
    if (!text) return false;
    if (STRONG_CHATTER.test(text)) return true;
    if (esConteo(word, vecina)) return true;
    if (WEAK_CHATTER.test(text)) {
        const trasSilencio = (pauseBefore == null ? 0 : pauseBefore) >= opt(options, 'weakPauseSec');
        // Y SUELTA, que es la otra mitad de la regla y faltaba. Estas palabras
        // existen dentro del habla normal, así que el silencio de delante no
        // alcanza para distinguirlas: en la clase 6, "Ya" abría la frase "Ya
        // Clauco nos entregó los planos de nuestra casa" a 0,35 s del conteo —
        // justo en el umbral—, se contaba como orden del director, y eso
        // bloqueaba el retraer del ajuste a frase: el bloque saltaba a la frase
        // siguiente y esa se perdía entera.
        //
        // Suelta significa que cierra su propia frase ("Ok.", "Listo.", "Ya.")
        // o que no hay nada detrás. Con más palabras pegadas es habla.
        return trasSilencio && (endsSentence(word) || !vecina);
    }
    return false;
}

/**
 * ¿Es un conteo de toma y no un número dicho dentro de la clase?
 * @param {object} vecina la palabra de al lado, para ver si van en fila
 */
function esConteo(word, vecina) {
    const text = textOf(word).trim();
    if (!COUNT_WORD.test(text)) return false;
    if (COUNT_DIGIT.test(text)) return true;
    return Boolean(vecina) && COUNT_WORD.test(textOf(vecina).trim());
}

/**
 * TODOS los conteos de toma de una lista de palabras, no solo el de la cabeza.
 *
 * Hace falta entero porque un conteo también aparece en el MEDIO de un bloque, y
 * ahí significa otra cosa: que el CD marcó el IN antes de una toma que el
 * profesor rehízo, y que las dos quedaron adentro del mismo bloque. Eso lo busca
 * `retoma.js`, y para encontrarlo no sirve mirar solo las primeras palabras.
 *
 * Los tramos son maximales: "3, 2, 1" es uno y no tres, porque lo que interesa
 * es dónde termina la cuenta y arranca la clase.
 *
 * @returns {Array<{desde:number, hasta:number}>} índices, en orden
 */
function conteosEn(lista) {
    const tramos = [];
    let i = 0;
    while (i + 1 < lista.length) {
        if (esConteo(lista[i], lista[i + 1]) && esConteo(lista[i + 1], lista[i])) {
            let fin = i + 1;
            while (fin + 1 < lista.length && esConteo(lista[fin + 1], lista[fin])) fin++;
            tramos.push({ desde: i, hasta: fin });
            i = fin + 1;
        } else i++;
    }
    return tramos;
}

/**
 * ¿Dónde termina el conteo de toma que abre esta lista de palabras?
 *
 * Vive acá y no en cada sitio que lo necesita porque son tres: el recorte lo
 * quita, el filtro de candidatos descarta los cortes que abren con él y la
 * medición lo cuenta. Con una copia en cada uno, el modelo podía elegir un corte
 * que el recorte hubiera rechazado.
 *
 * @returns {number} índice de la última palabra del conteo, o -1 si no hay
 */
function finDeConteo(lista) {
    // Solo los que empiezan lo bastante cerca del arranque como para ser el
    // conteo de ESTA toma, y sin pasar del tope: un conteo que sigue más allá de
    // la octava palabra ya no es la cuenta, es la clase hablando de números.
    const tope = MIRAR_CONTEO - 1;
    let fin = -1;
    for (const tramo of conteosEn(lista)) {
        if (tramo.desde + 1 > tope) break;
        fin = Math.max(fin, Math.min(tramo.hasta, tope));
    }
    return fin;
}

/** ¿Un corte en este punto dejaría el conteo dentro del bloque? */
function abreConConteo(words, timeSec) {
    return finDeConteo(spoken(words).filter(w => w.end > timeSec + 0.02).slice(0, MIRAR_CONTEO)) >= 0;
}

/** Las que se van solas, sin depender del silencio que traigan delante. */
function isHardChatter(word, vecina) {
    const text = textOf(word).trim();
    return Boolean(text) && (STRONG_CHATTER.test(text) || esConteo(word, vecina));
}

/**
 * Los límites que el borde no puede cruzar, sacados del transcript.
 *
 * Este es el arreglo de raíz del "Pau—": `audio-onset` coloca el corte con un
 * colchón de aire, y sin decirle dónde está la palabra vecina ese colchón se la
 * come. En el bloque 7 de la clase 01 el corte caía en 920.13 y "Pausa." iba de
 * 919.70 a 920.70.
 *
 * **Por qué sigue saliendo del transcript y no de la onda.** La pregunta se hizo
 * y se midió, porque estos límites se apoyan en duraciones de palabra de Whisper
 * y de esas no se puede confiar (4.940 palabras del curso, el 10,9%, duran algo
 * imposible). Se probaron cuatro formas de acotar sin ellas, sobre el alineado de
 * las trece clases y con los dos relojes. Ninguna sirve:
 *
 *   - Sin límite: los defectos de borde pasan de 54 a 110, y el habla del
 *     director metida en el corte de 1 a 60. Es el "Pau—" volviendo entero.
 *   - Con el mapa de voz (`voz.js`) en lugar del transcript, o sea "la búsqueda
 *     no cruza un tramo de sonido": 54 → 90, chatter 1 → 40.
 *   - Con el mapa de voz APRETANDO el de palabra, en vez de reemplazarlo: igual
 *     con el reloj crudo (54) y peor con el corregido (57 → 60).
 *   - Usando el final de palabra solo cuando `retimeo` no la marcó como rota:
 *     igual con el crudo, mucho peor con el corregido.
 *
 * El motivo es de fondo y conviene tenerlo escrito: lo que este límite protege es
 * la frontera entre DOS PALABRAS que suenan pegadas, y esa frontera vive dentro
 * de un único tramo de sonido. El mapa de voz sabe cuándo hay alguien hablando,
 * no cuándo dejó de decir "producto" y empezó a decir "pausa" — así que no puede
 * poner este límite ni con más resolución.
 *
 * Y protege por los DOS canales, medido soltando uno a la vez: acotando solo la
 * búsqueda del borde de sonido, el chatter salta de 1 a 37 (el colchón de diez
 * frames se estira sobre la palabra vecina); acotando solo el colchón, salta a
 * 32 (la búsqueda se agarra del "Pausa" y el corte se va hasta su final).
 *
 * **Lo que NO es un problema, aunque lo parezca.** El piso de un IN cae a veces
 * lejísimo —hasta 28,9 s con el reloj crudo, 31,0 s con el corregido— porque
 * delante del corte hay un silencio largo de verdad y la última palabra que
 * terminó está al otro lado. Eso no afloja nada: `audio-onset` busca en ±2 s
 * (`searchSec`) y descarta cualquier borde a más de `maxShiftSec`, así que un
 * piso a 25 s hace exactamente lo mismo que uno a 3. En el bloque 4 de la clase
 * 2 —el caso que se sospechaba— los dos pisos (793,53 con el reloj crudo y
 * 774,40 con el corregido) están los dos fuera de esa ventana: ninguno pudo
 * cambiar nada. Lo que cambió ahí fue el corte propuesto, de 771,04 a 798,86.
 *
 * @param {string} kind "IN" | "OUT"
 * @returns {{minTime: number|null, maxTime: number|null}}
 */
function wordLimits(words, timeSec, kind) {
    const list = spoken(words);
    if (!list.length) return { minTime: null, maxTime: null };

    if (kind === 'IN') {
        // Nada de lo que ya terminó antes del corte entra al bloque.
        let previousEnd = null;
        for (const word of list) {
            // Y "antes" pide que ARRANQUE antes, no solo que termine a tiempo.
            // Whisper entrega palabras de duración cero, y una de esas justo en
            // el corte cumplía la segunda condición sin cumplir la primera: se
            // contaba como palabra anterior y el suelo quedaba pegado al corte,
            // así que el colchón de aire no tenía dónde caber. Abriendo el
            // bloque 3 de la clase 1 en su segunda toma —«En» dura 0 s y arranca
            // exactamente en 263.04— el corte salía con 0,4 frames de aire en vez
            // de los diez que caben en los 0,66 s de silencio que hay delante.
            if (word.start >= timeSec - 0.01) break;
            if (word.end <= timeSec + 0.01) previousEnd = word.end;
            else break;
        }
        return { minTime: previousEnd, maxTime: null };
    }

    // OUT: el corte no puede llegar a la palabra que viene después.
    let nextStart = null;
    for (const word of list) {
        if (word.start >= timeSec - 0.01) { nextStart = word.start; break; }
    }
    return { minTime: null, maxTime: nextStart };
}

/** Combina dos límites quedándose con el más ajustado de cada lado. */
function tightest(a, b) {
    const pick = (x, y, harder) => {
        if (x == null) return y;
        if (y == null) return x;
        return harder(x, y);
    };
    return {
        minTime: pick(a.minTime, b.minTime, Math.max),
        maxTime: pick(a.maxTime, b.maxTime, Math.min)
    };
}

/**
 * Saca del bloque las órdenes al editor que quedaron pegadas a los bordes.
 * @returns {{startSec, endSec, removed: string[]}}
 */
function trimChatter(words, startSec, endSec, options) {
    const list = spoken(words);
    const removed = [];
    let start = startSec;
    let end = endSec;

    const inside = () => list.filter(w => w.end > start + 0.02 && w.start < end - 0.02);

    // El silencio es lo que delata a un "listo" o un "ya" sueltos: sin él son
    // parte de la frase. Pero si lo que viene justo antes ya es una orden —un
    // "Pausa.", un conteo—, el aparte ya empezó y no hace falta buscarle silencio
    // propio, porque el silencio quedó del otro lado de la orden. En "…el
    // proyecto. Pausa. Listo. 3, 2, 1." el hueco delante de "Listo." mide 0.30s,
    // por debajo del listón, y por eso el borde se quedaba terminando en "Listo.".
    const silencioAntesDe = (block, at) => {
        if (at > 0 && isHardChatter(block[at - 1], block[at - 2])) return 999;
        return at > 0 ? block[at].start - block[at - 1].end : 999;
    };

    // Por el final: la orden al editor llega después de la última frase.
    for (let guard = 0; guard < 6; guard++) {
        const block = inside();
        if (block.length < 2) break;
        const last = block[block.length - 1];
        const before = block[block.length - 2];
        const pause = silencioAntesDe(block, block.length - 1);
        if (!isChatter(last, pause, options, before)) break;
        removed.push(textOf(last));
        // Whisper entrega palabras que se solapan, así que llevar el borde al
        // final de la anterior puede dejar el chatter medio adentro y el bucle lo
        // saca de nuevo sin haberse movido. Se cierra donde el chatter arranca.
        end = Math.min(before.end, last.start);
    }

    // La cuenta atrás es el "ya" de la toma: lo que viene detrás es la clase y lo
    // que viene delante, no. Se mira antes que nada porque el bucle de abajo va
    // palabra por palabra y para en la primera que no es charla, así que un "Ok."
    // que no traiga silencio propio le tapa el conteo que viene detrás y el
    // bloque abre con "Ok. 3, 2, 1. En este curso…" entero.
    //
    // Hace falta que sean DOS seguidas. Una sola no es un conteo: "Uno de los
    // problemas más comunes" y "Tres cosas antes de empezar" abren clases de
    // verdad, y tirarlas por parecerse a un conteo se lleva por delante justo la
    // frase que presenta el bloque.
    const arranque = inside();
    const finDelConteo = finDeConteo(arranque);
    if (finDelConteo >= 0 && finDelConteo + 1 < arranque.length) {
        for (let i = 0; i <= finDelConteo; i++) removed.push(textOf(arranque[i]));
        // Donde ARRANCA la palabra siguiente, no donde termina el conteo. Whisper
        // entrega palabras que se pisan, y el "uno." de la cuenta terminaba
        // después de que empezara la frase: llevar el borde a ese final se comía
        // «Para ver» en la clase 9 y «En» en la 13. Dejar dentro la cola de un
        // conteo no molesta —el afinado con la onda la resuelve, porque entre la
        // cuenta y la toma siempre hay silencio—; perder las dos primeras
        // palabras de la clase, sí.
        start = arranque[finDelConteo + 1].start;
    }

    // Por el principio: sobras del conteo o un "ok" del director.
    for (let guard = 0; guard < 6; guard++) {
        const block = inside();
        if (block.length < 2) break;
        const first = block[0];
        const idx = list.indexOf(first);
        const pause = idx > 0 ? first.start - list[idx - 1].end : 999;
        if (!isChatter(first, pause, options, block[1])) break;
        removed.push(textOf(first));
        // Igual que arriba: con palabras solapadas, abrir donde empieza la
        // siguiente puede dejar adentro el final del conteo. Se abre pasado el
        // chatter, que es lo único que garantiza avanzar.
        start = Math.max(block[1].start, first.end);
    }

    if (end - start < opt(options, 'minKeepSec')) {
        // Recortar dejó el bloque en nada: se prefiere el bloque con ruido antes
        // que un bloque que no se entiende.
        return { startSec, endSec, removed: [] };
    }
    return { startSec: start, endSec: end, removed };
}

/**
 * Lleva un borde a donde cierra (o abre) una frase.
 *
 * Cuando la puntuación fuerte está apenas unas palabras atrás, lo que sobra es
 * el arranque de la frase siguiente y se RETRAE —el caso "…que debes aprender.
 * Igual,"—. Cuando no hay ninguna cerca, la frase de verdad sigue y se EXTIENDE
 * hasta que cierre.
 *
 * @returns {{timeSec, moved, how, candidates: {retract: number|null, extend: number|null}}}
 */
function snapToSentence(words, timeSec, kind, options) {
    const list = spoken(words);
    const limit = opt(options, 'maxShiftSec');
    const result = { timeSec, moved: false, how: 'sin cambio', candidates: { retract: null, extend: null } };
    if (!list.length) return result;

    if (kind === 'OUT') {
        const inside = list.filter(w => w.end <= timeSec + 0.02);
        if (!inside.length) return result;
        const last = inside[inside.length - 1];
        if (endsSentence(last)) {
            result.how = 'ya cerraba una frase';
            return result;
        }

        const back = Math.min(opt(options, 'retractWords'), inside.length - 1);
        for (let i = inside.length - 2; i >= inside.length - 1 - back && i >= 0; i--) {
            if (endsSentence(inside[i])) { result.candidates.retract = inside[i].end; break; }
        }

        const from = list.indexOf(last);
        for (let i = from + 1; i < list.length; i++) {
            const word = list[i];
            if (word.end - timeSec > limit) break;
            const pause = word.start - list[i - 1].end;
            // Con la palabra de al lado: sin ella, `isChatter` no puede ver si la
            // palabra viene suelta —que es lo que la hace una orden— y trata
            // como aparte del director cualquier "ya" o "bueno" del habla normal.
            if (isChatter(word, pause, options, list[i + 1])) break;
            if (endsSentence(word)) { result.candidates.extend = word.end; break; }
        }

        if (result.candidates.retract != null) {
            result.timeSec = result.candidates.retract;
            result.moved = true;
            result.how = 'se retrajo al final de la frase anterior';
        } else if (result.candidates.extend != null) {
            result.timeSec = result.candidates.extend;
            result.moved = true;
            result.how = 'se extendió hasta cerrar la frase';
        } else {
            result.how = 'no hay dónde cerrar la frase cerca';
        }
        return result;
    }

    // IN: el bloque tiene que abrir con una frase, no con su mitad.
    const idx = list.findIndex(w => w.end > timeSec + 0.02);
    if (idx === -1) return result;
    const first = list[idx];
    const previous = idx > 0 ? list[idx - 1] : null;

    if (!previous || endsSentence(previous)) {
        result.how = 'ya abría una frase';
        return result;
    }

    // Hacia atrás: el principio de la frase que este bloque parte por la mitad.
    // `minTime` es el suelo de quien llama —la claqueta, el bloque anterior— y
    // acá importa porque esto es lo único del alineado que mueve un IN hacia
    // atrás: sin él, abrir la frase podía meterse en la claqueta.
    const suelo = options && options.minTime != null ? options.minTime : null;
    for (let i = idx - 1; i >= 0; i--) {
        if (timeSec - list[i].start > limit) break;
        if (suelo != null && list[i].start < suelo) break;
        const pause = i > 0 ? list[i].start - list[i - 1].end : 999;
        // Igual que arriba, con la vecina. Acá se notaba peor: "Ya" abría la
        // frase "Ya Clauco nos entregó los planos" y sin la vecina contaba como
        // orden del director, así que este bucle cortaba y el bloque se iba a la
        // frase siguiente — perdiendo la primera entera.
        if (isChatter(list[i], pause, options, list[i + 1])) break;
        if (i === 0 || endsSentence(list[i - 1])) { result.candidates.retract = list[i].start; break; }
    }
    // Hacia adelante: el arranque de la frase siguiente.
    for (let i = idx; i < list.length - 1; i++) {
        if (list[i].end - timeSec > limit) break;
        if (endsSentence(list[i])) { result.candidates.extend = list[i + 1].start; break; }
    }

    if (result.candidates.retract != null) {
        result.timeSec = result.candidates.retract;
        result.moved = true;
        result.how = 'se abrió al principio de la frase';
    } else if (result.candidates.extend != null) {
        result.timeSec = result.candidates.extend;
        result.moved = true;
        result.how = 'se abrió en la frase siguiente';
    } else {
        result.how = 'no hay un arranque de frase cerca';
    }
    return result;
}

/** Las palabras que quedan dentro de un tramo. */
function wordsInside(words, startSec, endSec) {
    return spoken(words).filter(w => w.end > startSec + 0.02 && w.start < endSec - 0.02);
}

/** El texto de un tramo, tal como sonaría al verlo cortado. */
function textInside(words, startSec, endSec) {
    return wordsInside(words, startSec, endSec).map(textOf).join(' ').trim();
}

/**
 * ¿Un tramo así cortado termina a mitad de frase?
 *
 * Es EL criterio de "final colgando" del proyecto: lo usan el detector de
 * repeticiones para no cambiar un defecto por otro, el repaso para saber qué
 * arreglar y las herramientas de medición para contarlo. Vivía copiado en cada
 * uno, y tres copias de la definición son tres maneras de medir distinto.
 */
function quedaColgando(words, startSec, endSec) {
    const dentro = wordsInside(words, startSec, endSec);
    return Boolean(dentro.length) && !endsSentence(dentro[dentro.length - 1]);
}

/**
 * ¿Suena alguien dentro de este tramo? Con el mapa de voz de `engine/voz.js`.
 *
 * Se pregunta a la onda y no al transcript porque los tiempos de palabra de
 * Whisper no aguantan que se los mire de cerca —el 8,3% del curso figura
 * durando CERO— y acá se están mirando decenas de milisegundos.
 *
 * Un frame es el piso de lo que cuenta. El corte se escribe en frames, así que
 * rozar el borde de un tramo de voz no es llevárselo: es la misma cuenta que ya
 * hace `audio-onset.insideVoice` con su frame de margen.
 *
 * Y no sirve `audio-onset.voiceAt` para esto aunque conteste algo parecido: ese
 * saca el umbral de una ventana de ±2,3 s alrededor del corte, y en un tramo de
 * habla continua esa ventana es toda voz, así que el umbral local se le sube y
 * contesta que no. Medido en el bloque 2 de la clase 11, con el profesor
 * diciendo «…escribiendo test unitarios» encima del corte, `voiceAt` da false en
 * 132,5 · 133,0 · 133,4 · 133,6 y 133,7. El mapa de voz saca el umbral de la
 * clase entera y ve el tramo entero: 132,06–133,74.
 *
 * @param {object|null} voz mapa de voz de la clase
 * @param {number} desdeSec
 * @param {number} hastaSec
 * @param {number} [fps] para el piso de un frame; 30 si no se dice
 * @returns {boolean|null} null cuando no hay mapa y no se puede afirmar nada
 */
function suenaEntre(voz, desdeSec, hastaSec, fps) {
    const tramos = voz && voz.tramos;
    if (!tramos || !tramos.length) return null;
    const minimo = 1 / (fps || 30);
    let suma = 0;
    for (const [desde, hasta] of tramos) {
        if (hasta <= desdeSec) continue;
        if (desde >= hastaSec) break;
        // Sin dejar que un tramo aporte negativo: `desdeSec` puede caer DESPUÉS
        // de `hastaSec` —la palabra de antes arranca pasado el corte, que es
        // justo uno de los casos que esto existe para ver— y un solapamiento
        // negativo taparía el de un tramo posterior.
        suma += Math.max(0, Math.min(hasta, hastaSec) - Math.max(desde, desdeSec));
        if (suma > minimo) return true;
    }
    return false;
}

/**
 * Cuánto tiene que durar un tramo del mapa para que sea voz y no un crujido.
 *
 * **Este número es la corrección de un error de medición, y sin él el arreglo del
 * aire no arregla nada.** El mapa de `engine/voz.js` marca cualquier sonido de
 * 40 ms (`voz.MINIMO_SEC`), y en una sala hay muchos: en los nueve segundos
 * mudos del bloque 1 de la clase 13 el mapa reporta OCHO tramos —118,50 · 123,12
 * · 123,24 · 124,60 · 125,18 · 125,30 · 127,12 · 127,84—, de 60 a 280 ms. Con
 * ffmpeg esos mismos segundos miden entre −44 y −56 dB, o sea mudos. Preguntarle
 * al mapa «¿suena algo?» contesta que sí a medio segundo del IN y no mueve nada;
 * peor, esas migas parten el hueco en pedazos de menos de cinco segundos y una
 * primera medición del curso ni lo encontró.
 *
 * La idea de exigir sonido SOSTENIDO ya está en el repo: `audio-onset.voiceRuns`
 * descarta los tramos más cortos que `minRun` por esto mismo. Lo que cambia acá
 * es el largo, porque el mapa de voz ya viene con el filtro de 40 ms de
 * `audio-onset` puesto y hace falta uno más alto.
 *
 * **Dónde ponerlo, medido sobre los 19.427 tramos del curso.** Cruzando cada
 * tramo con el transcript, la proporción que tiene una palabra encima sube con el
 * largo sin saltos: 36% a los 40–60 ms, 51% a los 100–150, 70% a los 200–250,
 * 88% a los 400–600, 98% al segundo. No hay valle donde cortar, así que el
 * criterio no puede ser la forma de la curva: es que una sílaba de este curso
 * dura 192 ms (40.744 palabras, 5,22 sílabas por segundo hablado), y algo más
 * corto que una sílaba no es alguien hablando. Un cuarto de segundo es una sílaba
 * con margen, y tirar todo lo que esté por debajo cuesta el 34% de los tramos
 * pero solo el 8,9% del sonido: son migas.
 *
 * Y en el material se comprueba en la dirección que importa. Con 0,20 s los dos
 * bloques cuyo defecto está confirmado por render —clase 7 bloque 8 y clase 11
 * bloque 1— NO aparecen, porque una miga de 0,20–0,25 les parte el hueco al
 * medio. Con 0,25 aparecen los dos.
 */
const VOZ_MINIMA_SEC = 0.25;

/**
 * Y un hueco tiene que durar esto para que sea aire muerto y no una pausa.
 *
 * Acá tampoco hay valle: los huecos del curso decaen parejo (82 de más de 2 s,
 * 44 de 3, 26 de 4, 14 de 5, 8 de 6, 3 de 10). El listón es el del editor, que
 * revisó el curso entregado con esta vara, y lo que lo sostiene es lo que se
 * escucha a cada lado. De los 5 s para arriba los catorce huecos son o el
 * profesor esperando a una herramienta o una toma que se abandonó; de los 5 para
 * abajo entran sus pausas, incluido el hueco de 3,34 s con que abre el bloque 14
 * de la clase 2, que renderizado suena «Déjamelo en los comentarios y luego le
 * damos», o sea clase.
 */
const HUECO_MINIMO_SEC = 5;

/**
 * Los tramos del mapa que duran lo suficiente para ser voz.
 *
 * @param {object|null} voz mapa de voz de la clase (`engine/voz.js`)
 * @param {number} [minimoSec] `VOZ_MINIMA_SEC` si no se dice
 * @returns {Array<[number, number]>}
 */
function vozSostenida(voz, minimoSec) {
    const minimo = minimoSec == null ? VOZ_MINIMA_SEC : minimoSec;
    return ((voz && voz.tramos) || []).filter(([desde, hasta]) => hasta - desde >= minimo);
}

/**
 * Desde dónde habla alguien al micrófono, mirando hacia adelante.
 *
 * @returns {number|null} el tiempo, o null sin mapa o si nadie habla en el tramo
 */
function arranqueDelSonido(voz, desdeSec, hastaSec, minimoSec) {
    const tramos = vozSostenida(voz, minimoSec);
    if (!tramos.length) return null;
    for (const [desde, hasta] of tramos) {
        if (hasta <= desdeSec) continue;
        if (desde >= hastaSec) return null;
        // Un tramo que arranca ANTES del borde y sigue después no deja hueco: se
        // está hablando encima del corte, y el arranque es el corte mismo.
        return Math.max(desde, desdeSec);
    }
    return null;
}

/**
 * Los pedazos de aire muerto que hay entre dos tiempos, según el mapa de voz.
 *
 * **Qué mide el mapa, dicho con precisión, porque de eso depende que esto sea
 * legítimo.** No mide silencio: mide si alguien habla ENTRANDO AL MICRÓFONO, con
 * el umbral sacado de la clase entera. El ensayo y la charla de rodaje pasan a
 * dos metros del micro y quedan 20 dB por debajo de la toma —en la clase 13 el
 * ensayo pica entre −44 y −56 dB y la toma entre −25 y −35—, así que el mapa los
 * deja afuera. Para un curso esa es exactamente la pregunta que hay que hacer: la
 * clase se dice siempre al micrófono, y lo que se dice lejos es rodaje.
 *
 * Los bordes del tramo NO abren hueco por sí solos: un bloque bien cortado tiene
 * diez cuadros de aire a cada lado por diseño (`borde.js`), así que el silencio
 * que toca el borde solo cuenta si llega a `HUECO_MINIMO_SEC` por su cuenta.
 *
 * @param {object|null} voz mapa de voz; sin él no se puede afirmar nada
 * @param {object} [options] `{minimoSec, huecoMinimoSec}`
 * @returns {Array<{desdeSec, hastaSec, largoSec, alAbrir, alCerrar}>|null}
 */
function huecosDeAire(voz, desdeSec, hastaSec, options) {
    if (!voz || !voz.tramos || !voz.tramos.length) return null;
    const minimoHueco = (options && options.huecoMinimoSec) || HUECO_MINIMO_SEC;
    const tramos = vozSostenida(voz, options && options.minimoSec)
        .filter(([d, h]) => h > desdeSec && d < hastaSec);

    const huecos = [];
    let cursor = desdeSec;
    const anotar = (d, h) => {
        if (h - d < minimoHueco) return;
        huecos.push({
            desdeSec: Math.round(d * 100) / 100,
            hastaSec: Math.round(h * 100) / 100,
            largoSec: Math.round((h - d) * 100) / 100,
            alAbrir: d - desdeSec < 0.05,
            alCerrar: hastaSec - h < 0.05
        });
    };
    for (const [d, h] of tramos) {
        if (d > cursor) anotar(cursor, d);
        cursor = Math.max(cursor, h);
    }
    if (cursor < hastaSec) anotar(cursor, hastaSec);
    return huecos;
}

/**
 * ¿Y ABRE partiendo una frase por la mitad?
 *
 * Es la otra mitad de "queda colgando" y faltaba, que no es lo mismo que no
 * hacer falta: era el punto ciego por el que la vara se podía mejorar empeorando
 * la clase. Correr los IN detrás del conector con el que abren deja `conector`
 * en cero, y ninguna otra cuenta ve lo que rompe, porque todas miran el final
 * del bloque. Esta lo ve, y se prueba con `tools/variante-conector.js`: sobre
 * los planes entregados, mover los 15 lleva el total de 8 a 12.
 *
 * **La pregunta son DOS, y la segunda no la puede contestar el transcript.**
 *
 * La primera sí: la palabra que quedó del otro lado del corte, ¿cerraba una
 * frase? Si cerraba, el bloque abre por donde tiene que abrir. (Y el conteo de la
 * toma no cuenta: el motor lo tira a propósito, así que del otro lado queda muchas
 * veces un «1» sin punto. Descontarlo se llevó nueve de los dieciséis que esta
 * cuenta informaba al escribirse: eran cortes buenos abriendo justo tras la cuenta.)
 *
 * La segunda es si el corte de verdad se llevó esa palabra, y ahí el transcript
 * no llega. Sobre el curso entregado esta cuenta daba 7 bloques; escuchándolos
 * —cortando el Live-Mix por los bordes del plan y transcribiendo ESE pedazo, que
 * es lo único que no se puede discutir— **5 de los 7 tenían la palabra adentro**:
 *
 *   - clase 1 bloque 14 suena «Y justo ese es el problema…», con la «y» que el
 *     transcript pone en 2288,06–2288,07 y el corte en 2288,10. En la onda no
 *     hay nada entre 2287,74 y 2288,14: esa «y» no está donde el reloj la pone.
 *   - clase 2 bloque 1 suena «Un PROM sirve para crear demos…» (corte 45,267,
 *     ataque del sonido 45,26).
 *   - clase 2 bloque 15 suena «Ahora vamos a hacer el ejercicio…» (corte
 *     2430,533, la palabra arranca en 2430,54: el corte está ANTES).
 *   - clase 10 bloque 5 suena «Y si damos clic en este link…» (corte 856,10,
 *     sonido desde 856,16).
 *   - clase 3 bloque 13 abre en «En este punto vamos a parar», que es una frase
 *     entera; lo que el transcript tiene delante es un «que luego,» de una toma
 *     que el profesor abandonó 2,1 s antes.
 *
 * Las cuatro primeras son la misma cosa: el bloque abre en el ataque de la
 * primera palabra de la toma, y esa palabra figura en el transcript con 10 ms de
 * duración terminando un pelo antes del corte, así que `wordsInside` la deja
 * afuera por su margen de 20 ms. Las distancias son 3, 10, 17 y 30 ms — menos de
 * un frame— y el reloj no tiene resolución para eso. Por eso la segunda pregunta
 * va a la onda.
 *
 * **Los 2 que quedan son los 2 bloques del curso con el transcript roto**, y
 * esta cuenta es lo único que los señala:
 *
 *   - clase 11 bloque 2 suena «con Cypress. Sin embargo, con sistemas
 *     agénticos…» y le faltan seis segundos de su propia frase: el profesor
 *     había dicho «Tradicionalmente, para evaluar un sistema como estos,
 *     deberíamos dedicarle horas escribiendo test unitarios con Cypress». Hubo
 *     dos tomas y el transcript guardado se comió la segunda entera, así que la
 *     nota del CD no tuvo dónde anclar y el corte quedó a mitad de la frase.
 *   - clase 3 bloque 13 abre bien —«En este punto vamos a parar…»— y esta cuenta
 *     lo marca por la palabra suelta de una toma abandonada que tiene delante.
 *     Pero el bloque igual está mal: adentro trae la toma DOS VECES con el «Ok.
 *     Ok. 3, 2, 1.» en el medio, y `retoma` no lo puede ver porque el transcript
 *     también perdió ese tramo. La cuenta acierta por la razón equivocada.
 *
 * **Y uno que esta cuenta ya no ve, anotado para que no se busque**: clase 13
 * bloque 4 suena «no me refiero al código…», sin la «Y» que el CD había escrito
 * delante. El profesor hizo una pausa de 0,64 s después de esa «Y», así que en
 * la onda es un tramo aparte y entre él y el corte no suena nadie —
 * indistinguible de una toma que empieza ahí. Lo que lo delata es la nota del
 * CD, que abre con «Y», no esto.
 *
 * @param {object|null} voz mapa de voz de la clase; sin él no se puede afirmar
 */
function abreAMitad(words, startSec, endSec, voz) {
    const lista = spoken(words);
    const dentro = wordsInside(words, startSec, endSec);
    if (!dentro.length) return false;
    const idx = lista.indexOf(dentro[0]);
    if (idx <= 0) return false;
    const previa = lista[idx - 1];
    if (endsSentence(previa)) return false;
    // La vecina que se le pasa es la de ATRÁS, y en este sitio no es lo mismo que
    // la de adelante: un conteo termina siempre justo antes del IN, así que la
    // única palabra que puede delatar al «uno,» del final de la cuenta es el
    // «dos,» que tiene detrás — la de adelante ya es la clase. Mirando hacia
    // adelante, el bloque 8 de la clase 6 contaba como frase partida cuando lo que
    // tiene del otro lado es el final de «Tres, dos, uno,».
    const pausa = idx > 1 ? previa.start - lista[idx - 2].end : 999;
    if (isChatter(previa, pausa, null, lista[idx - 2])) return false;
    // Y la segunda mitad: que esa palabra se haya ido de verdad, o sea que haya
    // sonado alguien entre donde el transcript la pone y el corte.
    //
    // Sin mapa de voz no se afirma. Quien mide tiene que contar aparte los
    // bloques que se quedaron sin medir, como ya hace con los bordes sin la
    // medición de onda: contestar que sí con el reloj es lo que daba 7 en un
    // curso que tiene 2.
    //
    // Se pregunta sobre el mapa SIN MIGAS (`vozSostenida`), y no es un detalle de
    // implementación: el piso de `suenaEntre` es un frame, y un crujido de sala de
    // 60 ms lo pasa. Cuando la palabra de al lado está a cinco segundos del corte
    // —porque el transcript la puso mal, que es justo la situación de estos
    // bloques— en el medio hay sala de sobra: en el bloque 1 de la clase 13, entre
    // «es» (121,64) y el corte hay cinco tramos de 60 a 100 ms y ni uno es nadie
    // hablando. Contándolos, esta cuenta informaba dos frases partidas que no
    // existen y las informaba justo en los dos bloques donde `aire` acababa de
    // sacar el ensayo: el arreglo se veía como un empeoramiento.
    return suenaEntre({ tramos: vozSostenida(voz) }, previa.start, startSec) === true;
}

/**
 * Por debajo de esto, el transcript no sirve para decidir cortes.
 *
 * El número sale de medir las trece clases del curso: las sanas van de 9,3 % a
 * 15,4 % de palabras cerrando frase, y la clase 6 enferma —whisper.cpp trabado
 * arrastrando su propio texto entre ventanas— estaba en 2,5 %. 5 % parte esa
 * distancia por el medio: es la mitad de la peor clase sana y el doble de la
 * enferma, así que no hay forma de que una clase normal lo dispare ni de que
 * una trabada se escape.
 */
const CIERRES_MINIMOS = 0.05;

/**
 * Cuánta puntuación de cierre trae un transcript.
 *
 * Existe porque es la comprobación que habría delatado la clase 6 ocho pasos
 * antes de que el defecto se viera. Todo lo de acá abajo —el ajuste a frase, el
 * recorte del habla del director, el "queda colgando"— se apoya en saber dónde
 * termina una frase. Un transcript sin puntuación no hace fallar nada: hace que
 * cada bloque se corte donde caiga y que el problema aparezca al final,
 * disfrazado de "ocho finales colgados", en un sitio donde ya no se puede
 * atribuir a la transcripción.
 *
 * El pozo se mide además del porcentaje porque el porcentaje es global y el
 * daño es local: la clase 12 tiene un 13,9 % sano y aun así se pasa 599
 * segundos seguidos sin un punto, y todos los bloques que caen ahí adentro se
 * cortan a ciegas. El porcentaje decide el aviso; el pozo es lo que después
 * explica por qué una clase con buen número igual salió mal.
 *
 * @returns {{palabras:number, cierres:number, ratio:number, pozoSec:number, sirve:boolean}}
 */
function densidadDeCierres(words) {
    const dichas = spoken(words);
    let cierres = 0;
    let pozoSec = 0;
    // El pozo se mide desde el principio del habla y hasta el final, no solo
    // entre dos puntos. Con un transcript que trae un único punto al final, la
    // cuenta "entre cierres" da cero y el peor caso posible se informa como el
    // mejor; el tramo sin puntuación es toda la clase menos la última palabra.
    let ultimo = dichas.length ? dichas[0].start : null;
    for (const word of dichas) {
        if (!endsSentence(word)) continue;
        cierres++;
        pozoSec = Math.max(pozoSec, word.end - ultimo);
        ultimo = word.end;
    }
    if (ultimo != null) {
        pozoSec = Math.max(pozoSec, dichas[dichas.length - 1].end - ultimo);
    }
    const ratio = dichas.length ? cierres / dichas.length : 0;
    return {
        palabras: dichas.length,
        cierres,
        ratio: Math.round(ratio * 10000) / 10000,
        pozoSec: Math.round(pozoSec * 10) / 10,
        // Un transcript vacío no es un transcript malo: es una clase sin audio,
        // y de eso ya avisa el alineado. Decir además que "no sirve para
        // cortar" sería el mismo problema contado dos veces.
        sirve: !dichas.length || ratio >= CIERRES_MINIMOS
    };
}

module.exports = {
    isChatter,
    isHardChatter,
    esConector,
    largoDeConector,
    conectorSinPedir,
    CONECTOR_HUERFANO,
    endsSentence,
    densidadDeCierres,
    CIERRES_MINIMOS,
    wordLimits,
    tightest,
    trimChatter,
    snapToSentence,
    wordsInside,
    textInside,
    quedaColgando,
    abreAMitad,
    suenaEntre,
    vozSostenida,
    arranqueDelSonido,
    huecosDeAire,
    VOZ_MINIMA_SEC,
    HUECO_MINIMO_SEC,
    spoken,
    textOf,
    esConteo,
    conteosEn,
    finDeConteo,
    abreConConteo,
    STRONG_CHATTER,
    WEAK_CHATTER,
    COUNT_WORD,
    DEFAULTS
};
