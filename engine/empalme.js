'use strict';
/**
 * empalme.js — Si la toma que acaba de cerrar pega con la anterior.
 *
 * El profesor dice "Pausa", respira, y al retomar vuelve a decir lo último que
 * ya había dicho para agarrar impulso. Pegadas una atrás de la otra, las dos
 * tomas dicen lo mismo dos veces. Eso hoy se descubre en la mesa de edición,
 * cuando la clase ya pasó y no se puede volver a grabar: acá se avisa en el
 * momento y con el arreglo hecho, para que el que está grabando decida.
 *
 * **Esto NO es un segundo detector de repeticiones**, y esa es la decisión más
 * importante del archivo. El de la app es `repeticiones.js` y sigue siendo el
 * único: la pregunta "¿dónde, adentro del bloque de antes, arranca lo que el de
 * después va a volver a decir?" es exactamente su `solapeEntre` —con su
 * emparejamiento difuso, su filtro de palabras con contenido y sus mínimos
 * medidos— y acá se lo llama tal cual. Lo único que se agrega es un traductor de
 * un reloj al otro: en post las palabras son segundos desde el principio del
 * WAV, en vivo son la hora del día.
 *
 * Lo que `repeticiones.js` no puede tener, porque trabaja sobre el guion ya
 * cerrado y con el WAV entero en la mano, es lo otro que hay acá:
 *
 * - **Preguntarle a un modelo cuando la paráfrasis no alinea.** Allá el material
 *   son dos tomas del MISMO intento, que comparten tokens de sobra para que el
 *   alineador las encuentre. Acá el caso típico es que el profesor resuma con
 *   otras palabras lo que ya dijo, y ahí no hay tokens que alinear: hay una idea
 *   repetida, que es lo que un modelo ve y una regla no.
 *
 * - **No aplicar nada solo.** Allá el editor está mirando el resultado y puede
 *   deshacer; acá la clase se está grabando y el corte que se movería es el de
 *   una toma que el profesor todavía puede querer entera. Así que lo que sale de
 *   acá es un cambio YA ARMADO —el mismo `{tipo:'borde'}` que la pantalla manda
 *   cuando alguien arrastra la línea roja— y el botón lo manda sin traducir nada.
 *
 * **Sin estado, sin DOM y sin disco.** Quien lo llama cuando una toma queda
 * cerrada es `engine/medir-toma.js`, que es también quien decide si se puede
 * consultar un modelo en este momento (`engine/gpu.js`).
 */

const repeticiones = require('./repeticiones');
const speech = require('./speech-edges');
const { aplanar } = require('./texto');

/** 1: primera versión. Va guardada en la toma para poder releer lo viejo. */
const VERSION = 1;

/**
 * Cuántas palabras del final de la anterior se miran.
 *
 * Es el techo de todo lo que este archivo puede proponer: nunca se sugiere
 * recortar más allá de estas palabras.
 *
 * **No es un criterio de qué es una repetición** —ese es entero de
 * `repeticiones.js` y no se toca— sino un límite de lo que un botón puede hacer
 * de un clic mientras alguien graba. En post el recorte se aplica y después se
 * comprueba, y si no arregló nada se deshace (`aplicarRecorte` allá); acá no hay
 * nada que deshacer automáticamente, así que lo que se ofrece tiene que ser del
 * tamaño de lo que se está buscando: una frase que el profesor volvió a decir al
 * retomar. Un candidato de hace un minuto no es una retoma.
 *
 * Treinta palabras son unos once segundos al ritmo del curso (168 por minuto,
 * medido en `tools/medir-lengua.js`): entra la frase larga —las de este profesor
 * andan entre veinte y treinta palabras— y no entra el párrafo.
 *
 * Es también lo que se le muestra al modelo, y por eso su respuesta no puede
 * pasarse: la lista numerada que ve es exactamente esta cola.
 */
const COLA_PALABRAS = 30;

/**
 * Y cuántas del arranque de la nueva se comparan contra esa cola.
 *
 * Sale de `repeticiones.js` en vez de elegirse acá: es el mismo "cuánto hay que
 * leer del que viene para reconocer que repite" que ya está medido allá, y un
 * segundo número sería el principio de tener dos criterios.
 */
const CABEZA_PALABRAS = repeticiones.DEFAULTS.palabrasDeCabeza;

/**
 * Menos palabras que esto de cada lado y no se mira nada.
 *
 * Es el mínimo de `solapeEntre` para la cabeza, repetido acá para la cola y para
 * poder cortar antes de traducir nada. Con cinco palabras cualquier arranque se
 * parece a cualquier final, y decir "repite" donde no se sabe es peor que
 * callarse: el que graba deja de mirar el aviso.
 */
const MINIMO_PALABRAS = 6;

/**
 * Los dos mínimos del recorte, que son los de `repeticiones.js`.
 *
 * Están medidos allá sobre las trece clases del curso y quieren decir lo mismo:
 * recortar menos de segundo y medio no arregla un empalme —es el final del
 * bloque, no una retoma—, y si al recortar la toma anterior queda en menos de
 * tres segundos, no le sobraba la cola: era toda ella la toma que no salió, y
 * eso es descartarla, que es un gesto de una persona y no de un botón.
 */
const MINIMO_RECORTE_MS = repeticiones.DEFAULTS.minimoRecorteSec * 1000;
const MINIMO_QUEDA_MS = repeticiones.DEFAULTS.minimoQueQuedaSec * 1000;

/**
 * Cuánto se tienen que parecer los dos bordes para que valga una consulta.
 *
 * **Este número es lo que decide cuánto cuesta la función.** Sin él habría una
 * consulta por cada toma que cierra, o sea veinte por clase, para que el modelo
 * conteste "no, no repite" en casi todas. Con él se pregunta solo donde una
 * cuenta gratis ya vio que las dos puntas comparten lo que dicen.
 *
 * Es el `parecidoMinimo` de `repeticiones.js` y no uno propio, y no es casual
 * que sirva: allá mide "estas dos tomas dicen lo mismo" después de que el
 * alineador encontró dónde, y acá mide lo mismo antes de saber dónde. La cuenta
 * —qué fracción de las palabras CON CONTENIDO del arranque están también en el
 * final de la anterior— es la que ya distingue dos tomas de la misma frase de
 * dos frases que comparten el andamiaje del idioma.
 *
 * Medido con cinco empalmes armados a mano sobre el mismo final de toma
 * (`tools/probar-empalme.js`), que es lo que dice dónde cae cada caso:
 *
 *   1,00  vuelve a decirlo casi igual   → la regla sola, sin consulta
 *   0,60  sigue la frase donde quedó    → se pregunta, y el modelo dice que no
 *   0,50  lo mismo con otras palabras   → se pregunta, y de acá sale la sugerencia
 *   0,25  el mismo tema, sin repetir    → gratis, no se pregunta
 *   0,00  arranca otro tema             → gratis, no se pregunta
 *
 * O sea que el listón deja del lado caro exactamente la franja donde hace falta
 * un modelo: los dos casos que se parecen mucho y solo uno de los dos repite.
 * El de 0,50 pasa raspando, y eso quiere decir que alguna paráfrasis floja se va
 * a perder — se prefiere eso a preguntar por las veinte tomas de la clase.
 */
const PARECIDO_PARA_PREGUNTAR = repeticiones.DEFAULTS.parecidoMinimo;

/**
 * Cuánto se le espera al modelo por un empalme.
 *
 * El mismo número que `lengua.LIMITE_MS`, y por el mismo motivo: es cuánto tarda
 * el proveedor configurado en esta Mac —un "thinking" por el Cursor CLI—, medido
 * allá corriéndolo contra las tomas del curso, no estimado. Un límite ajustado no
 * recorta la espera: tira la respuesta.
 *
 * Está escrito dos veces porque es de la consulta y no del mecanismo: el día que
 * un medidor pregunte algo mucho más chico va a querer su propio techo. Si
 * aparece un cuarto con el mismo número, el sitio donde vive es `medir-toma.js`.
 */
const LIMITE_MS = 150000;

/**
 * Cuánto dura una palabra cuando nadie lo dijo.
 *
 * Hace falta por el traductor: `speech-edges` filtra por `start` y `end`, y las
 * palabras en vivo tienen la hora en que EMPIEZAN y a veces la de su final —el
 * sidecar guarda solo `t`, así que una clase releída del disco no lo trae—. El
 * mínimo es lo que importa: sin él, una palabra que Whisper devolvió durando
 * cero se cae del tramo al que pertenece, y el 8,3% del curso figura durando
 * cero. El máximo evita que la última palabra antes de un silencio largo se
 * estire hasta la toma siguiente.
 */
const LARGO_MINIMO_MS = 150;
const LARGO_MAXIMO_MS = 900;

/* ─── Con quién empalma cada toma ────────────────────────────────────────── */

/**
 * La toma con la que esta va a quedar pegada en el XML.
 *
 * No es "la de antes en la lista": es la de antes que va a quedar. Una descartada
 * no llega al XML (`tomasQueQuedan` en `notas-vivo.js`), así que la que pega es
 * la anterior a esa, y validar contra material que nadie va a ver sería avisar de
 * una repetición que no existe.
 *
 * La primera toma de la clase no tiene con qué empalmar, y eso se sabe sin
 * preguntarle a nadie: es la mitad del ahorro que hace que esto no cueste una
 * consulta por toma.
 */
function anterior(tomas, toma) {
    const lista = tomas || [];
    if (!toma || toma.descartada) return null;
    const donde = lista.findIndex(t => t && t.id === toma.id);
    if (donde < 1) return null;

    for (let i = donde - 1; i >= 0; i--) {
        const previa = lista[i];
        if (!previa || previa.descartada) continue;
        if (previa.inMs == null || previa.outMs == null) continue;
        if ((previa.palabras || []).length < MINIMO_PALABRAS) continue;
        return previa;
    }
    return null;
}

/** Las últimas palabras de la toma anterior: lo único que se puede recortar. */
function colaDe(toma) {
    const palabras = toma.palabras || [];
    return palabras.slice(Math.max(0, palabras.length - COLA_PALABRAS));
}

/** Las primeras de la que acaba de cerrar: lo que puede estar repitiendo. */
function cabezaDe(toma) {
    return (toma.palabras || []).slice(0, CABEZA_PALABRAS);
}

function textoDe(palabras) {
    return (palabras || []).map(w => String(w.texto == null ? '' : w.texto).trim())
        .filter(Boolean).join(' ');
}

/* ─── Lo que se resuelve sin modelo ──────────────────────────────────────── */

/**
 * Cuánto de lo que dice el arranque de la nueva ya lo decía el final de la vieja.
 *
 * Gratis, instantáneo y no falla. Es la puerta: por debajo del listón no hay
 * nada que mirar y no se paga ninguna consulta.
 */
function parecidoDeLosBordes(previo, actual) {
    const cola = colaDe(previo);
    const cabeza = cabezaDe(actual);
    if (cola.length < MINIMO_PALABRAS || cabeza.length < MINIMO_PALABRAS) return 0;
    return repeticiones.seParecen(textoDe(cabeza), textoDe(cola));
}

/**
 * Las dos tomas, habladas como las habla el motor de post.
 *
 * `repeticiones.solapeEntre` trabaja sobre lo que devuelve el alineador —una
 * lista de palabras con `start` y `end` en segundos desde el principio del WAV,
 * y bloques con `startSec` y `endSec`—, y las tomas en vivo llevan la hora del
 * día en milisegundos. Traducir es más barato que tener dos detectores: son
 * quince líneas contra un segundo criterio de qué es una repetición, que es
 * exactamente lo que no puede haber en esta app.
 *
 * El cero es el IN de la toma anterior, así que los números quedan chicos y la
 * vuelta —de segundo a palabra— no pierde precisión.
 */
function comoEnPost(previo, actual) {
    const base = previo.inMs;
    const enSegundos = ms => (ms - base) / 1000;

    const traducir = (palabras, techoMs) => (palabras || []).map((w, i, todas) => {
        const siguiente = todas[i + 1];
        const natural = w.hasta != null ? w.hasta : (siguiente ? siguiente.t : w.t + LARGO_MAXIMO_MS);
        const fin = Math.max(
            Math.min(natural, w.t + LARGO_MAXIMO_MS, techoMs),
            w.t + LARGO_MINIMO_MS
        );
        return { start: enSegundos(w.t), end: enSegundos(fin), text: w.texto };
    });

    return {
        words: traducir(previo.palabras, previo.outMs).concat(traducir(actual.palabras, actual.outMs)),
        previo: { index: 0, startSec: 0, endSec: enSegundos(previo.outMs) },
        siguiente: { index: 1, startSec: enSegundos(actual.inMs), endSec: enSegundos(actual.outMs) }
    };
}

/**
 * La palabra de la toma anterior que cae en ese segundo.
 *
 * Se vuelve a la palabra y no se redondea el número, y esa es la garantía de que
 * "Ajustar corte" siempre se pueda ejecutar: el corte que sale de acá es SIEMPRE
 * la hora exacta de una palabra que la toma dijo. Un milisegundo de deriva
 * dejaría el borde en un lugar donde `repartir` pone la palabra del otro lado, y
 * el recorte se comería una palabra de más o de menos.
 *
 * Si lo que devolvió el alineador no cae sobre ninguna palabra, no hay
 * sugerencia: es la misma aduana que se le hace al modelo, aplicada a la regla.
 */
const CERCA_MS = 200;

function palabraEn(palabras, base, timeSec) {
    const ms = base + timeSec * 1000;
    let mejor = null;
    for (const w of palabras || []) {
        if (!mejor || Math.abs(w.t - ms) < Math.abs(mejor.t - ms)) mejor = w;
    }
    return mejor && Math.abs(mejor.t - ms) <= CERCA_MS ? mejor : null;
}

/**
 * El empalme visto por la regla sola: dónde arranca, en la anterior, lo que la
 * nueva vuelve a decir.
 *
 * @returns {{paredMs:number, parecido:number}|null}
 */
function porRegla(previo, actual) {
    if ((previo.palabras || []).length < MINIMO_PALABRAS) return null;
    if ((actual.palabras || []).length < MINIMO_PALABRAS) return null;

    const enPost = comoEnPost(previo, actual);
    const solape = repeticiones.solapeEntre(enPost.words, enPost.previo, enPost.siguiente);
    if (!solape) return null;

    const palabra = palabraEn(previo.palabras, previo.inMs, solape.timeSec);
    if (!palabra) return null;
    return { paredMs: palabra.t, parecido: solape.parecido };
}

/* ─── La sugerencia, que tiene que poder ejecutarse ──────────────────────── */

/** Un tramo para subrayar, en horas de palabra: así lo ubica el resto de la app. */
function tramo(id, palabras) {
    if (!palabras || !palabras.length) return null;
    const ultima = palabras[palabras.length - 1];
    return {
        toma: id,
        desdeMs: palabras[0].t,
        hastaMs: ultima.hasta != null ? ultima.hasta : ultima.t,
        texto: textoDe(palabras)
    };
}

/**
 * El corte, llevado al arranque de la frase que parte por la mitad.
 *
 * **Esto es lo que hace que la respuesta del modelo se pueda ejecutar**, y salió
 * de la corrida real: preguntado por el empalme del pool de conexiones, el modelo
 * acertó qué se repetía pero señaló "no se abre de nuevo en cada consulta" en vez
 * de "La conexión a la base de datos no se abre…" —tres palabras tarde, adentro
 * de la frase—. Cortar ahí dejaba la toma anterior terminando en "La conexión a
 * la base de datos", y la sugerencia se caía por un detalle que el modelo no
 * tenía por qué acertar.
 *
 * Y no tiene por qué: QUÉ se repite es un juicio y para eso está el modelo, pero
 * DÓNDE se puede cortar es una propiedad del texto, y el proyecto ya la sabe
 * medir. Es el mismo `snapToSentence` con el que `align.js` abre los bloques —"el
 * bloque tiene que abrir con una frase, no con su mitad"—, y el borde que se
 * mueve acá es justamente el arranque de lo que se va a ir.
 *
 * Se usa SOLO el candidato hacia atrás. Extender hacia adelante es lo correcto
 * para un IN de verdad, pero acá dejaría media repetición del lado que se
 * conserva, que es no haber arreglado nada. Sin candidato hacia atrás el corte
 * queda donde estaba y lo resuelve la puerta de abajo.
 *
 * El piso es la cola: no se retrae más allá de las palabras que se le mostraron
 * al modelo, porque ahí ya se estaría proponiendo un corte sobre material que
 * nadie miró.
 */
function alArranqueDeLaFrase(previo, actual, paredMs) {
    const cola = colaDe(previo);
    if (!cola.length) return paredMs;

    const { words } = comoEnPost(previo, actual);
    const snap = speech.snapToSentence(words, (paredMs - previo.inMs) / 1000, 'IN', {
        minTime: (cola[0].t - previo.inMs) / 1000
    });
    if (snap.candidates.retract == null) return paredMs;

    const palabra = palabraEn(previo.palabras, previo.inMs, snap.candidates.retract);
    return palabra ? palabra.t : paredMs;
}

/**
 * ¿Cortar ahí dejaría a la toma anterior terminando a mitad de idea?
 *
 * Es la comprobación que `repeticiones.aplicarRecorte` hace después de recortar y
 * que acá se hace antes, porque acá no hay nada que deshacer: cambiar una
 * repetición por un final colgando no es un arreglo, es un defecto por otro, y
 * el final de una toma es justamente lo que después reancla el bloque en post
 * (el cue de salida que busca `align.js` en el Live-Mix).
 *
 * Se compara antes y después, como allá, y no se mira el estado final a secas:
 * una toma que YA terminaba a mitad de frase —el profesor dijo "Pausa" y cortó
 * donde le salió— no queda peor por recortarle lo que se repite, y descartar la
 * sugerencia por algo que ya estaba sería no arreglar nada nunca.
 */
function dejaColgando(previo, actual, paredMs) {
    const { words } = comoEnPost(previo, actual);
    const hasta = (previo.outMs - previo.inMs) / 1000;
    const corta = (paredMs - previo.inMs) / 1000;
    if (speech.quedaColgando(words, 0, hasta)) return false;
    return speech.quedaColgando(words, 0, corta);
}

/**
 * La sugerencia, armada una sola vez y desde un solo sitio.
 *
 * **Todo lo que sale de acá tiene que poder ejecutarse solo**, porque el botón no
 * va a interpretar nada: `ajuste` es literalmente el cambio que la pantalla ya
 * manda cuando alguien arrastra la línea roja (`{tipo:'borde'}` en `editar` de
 * `grabacion.js`), y `descartar` el que deja constancia de que no. Los dos se
 * mandan tal cual por `grabarEditar`.
 *
 * Que la regla y el modelo pasen los dos por acá es lo que garantiza que sean la
 * misma cosa. Si el camino del modelo armara su propio objeto, alcanzaría con que
 * una versión del prompt devolviera prosa para que el botón dejara de andar, y no
 * se notaría hasta que alguien lo apretara en medio de una clase.
 *
 * El corte que llega es un CANDIDATO: antes de mirarlo se lo lleva al arranque de
 * la frase (`alArranqueDeLaFrase`), porque ni el modelo ni el alineador tienen por
 * qué acertar la palabra exacta y eso no es lo que se les preguntó.
 *
 * Devuelve null cuando el corte no se puede hacer, y esas cinco comprobaciones
 * son la aduana entera. Se hacen ACÁ y no donde se descubre el corte porque hay
 * que rehacerlas cada vez que se mira: una sugerencia guardada puede haber
 * quedado hablando de una palabra que ya no está —la toma se releyó con el modelo
 * grande, o alguien movió el borde, o se aceptó la sugerencia de al lado—, y
 * mostrar un botón que no va a poder hacer nada es peor que no mostrarlo.
 */
function armarSugerencia(previo, actual, candidatoMs, origen, porque) {
    const palabras = previo.palabras || [];
    // La palabra existe, y es exactamente esta. Se pregunta por el candidato,
    // antes de correrlo, porque una palabra inventada no se arregla moviéndola.
    if (!palabras.some(w => w.t === candidatoMs)) return null;

    // Recién acá el corte es el que se va a ejecutar, así que las puertas de
    // abajo miran este número y no el que llegó.
    const paredMs = alArranqueDeLaFrase(previo, actual, candidatoMs);

    // Recortar menos que esto no arregla el empalme.
    if (previo.outMs - paredMs < MINIMO_RECORTE_MS) return null;
    // Y lo que queda de la toma anterior tiene que seguir siendo una toma.
    if (paredMs - previo.inMs < MINIMO_QUEDA_MS) return null;
    // Nunca más allá de la cola: un botón no propone cortar medio minuto.
    const cola = colaDe(previo);
    if (!cola.length || paredMs < cola[0].t) return null;
    // Y no se cambia un defecto por otro.
    if (dejaColgando(previo, actual, paredMs)) return null;

    const repetido = palabras.filter(w => w.t >= paredMs);
    return {
        origen,
        porque,
        // Lo que se subraya: el tramo de la anterior que se va a ir, y dónde se
        // vuelve a decir. Los dos en horas de palabra y no en índices de texto,
        // que es como el resto de la app ubica los comentarios y los bordes — un
        // índice de caracteres se rompe apenas la toma se relee con el modelo
        // grande y el texto cambia.
        enLaAnterior: tramo(previo.id, repetido),
        enEsta: tramo(actual.id, cabezaDe(actual)),
        ajuste: {
            tipo: 'borde',
            toma: previo.id,
            borde: 'out',
            paredMs,
            // Para que el botón pueda decir qué va a hacer antes de hacerlo.
            quitaSec: Math.round((previo.outMs - paredMs) / 100) / 10,
            palabras: repetido.length
        },
        descartar: { tipo: 'descartar-ajuste', toma: actual.id, contra: previo.id }
    };
}

/* ─── Lo que pide un modelo ──────────────────────────────────────────────── */

const SYSTEM = 'Sos un editor que mira el empalme entre dos tomas seguidas de una clase ' +
    'grabada, en español. Respondés SIEMPRE solo JSON válido, en español.';

/**
 * La consulta: la cola de la anterior numerada palabra por palabra, y el arranque
 * de la nueva.
 *
 * **Numerada porque la respuesta tiene que ser ejecutable.** Una explicación de
 * qué se repite no sirve para nada acá: el botón necesita saber qué borde de qué
 * toma se mueve y hasta qué palabra. Poniendo las palabras de la cola con su
 * número, la pregunta deja de ser "¿qué te parece?" y pasa a ser "¿desde cuál?",
 * que tiene una sola forma de contestarse y se puede verificar.
 *
 * **Y se pide además la cita, que es lo que se verifica de verdad.** Contar
 * renglones no es lo que mejor hace un modelo, pero copiar un texto que tiene
 * delante sí; si el número y la cita no dicen lo mismo, manda la cita, porque la
 * cita se puede comprobar contra lo que la toma dijo y el número no. Es la misma
 * aduana de `lengua.validar`: el ancla es lo que se dijo de verdad.
 */
function prompt(previo, actual) {
    const cola = colaDe(previo);
    const numeradas = cola
        .map((w, i) => `${i}\t${String(w.texto == null ? '' : w.texto).trim()}`)
        .join('\n');

    return `El profesor grabó una toma, dijo "Pausa" y al rato abrió la siguiente. Lo que pasa muy seguido es que al retomar vuelve a decir lo que ya había dicho al final de la anterior —casi nunca con las mismas palabras— para agarrar impulso. Pegadas una atrás de la otra, las dos tomas dicen lo mismo dos veces y el alumno lo escucha repetido.

FINAL DE LA TOMA ANTERIOR, una palabra por renglón y numeradas:
${numeradas}

ARRANQUE DE LA TOMA NUEVA:
${textoDe(cabezaDe(actual))}

¿El arranque de la toma nueva vuelve a decir algo que el final de la anterior YA decía? Que las dos hablen del mismo tema no alcanza: tiene que ser la misma idea dicha dos veces. Enganchar con un conector ("entonces", "bueno", "así que") tampoco cuenta, y seguir la frase donde había quedado tampoco: eso es continuar, no repetir.

Si se repite, decí DESDE QUÉ NÚMERO de la lista de arriba empieza lo que la toma nueva vuelve a decir. Ahí es donde se va a cortar la toma anterior, así que tiene que ser la PRIMERA palabra de lo repetido y no una del medio.

En "cita" van las palabras de la lista desde ese número hasta el final, copiadas tal como están escritas: si la cita no está en la lista, la sugerencia se descarta.

Respondé solo JSON:
{"repite": true, "desde": <número de la lista>, "cita": "<las palabras copiadas de la lista>", "porque": "<qué se dice dos veces, en una frase>"}

Si la toma nueva no vuelve a decir nada:
{"repite": false}`;
}

/**
 * Desde qué palabra de la cola arranca la cita del modelo.
 *
 * Se compara aplanado —sin acentos, sin signos y con los espacios normalizados—
 * porque el modelo repuntúa lo que copia y pedir coincidencia exacta tiraría
 * respuestas buenas por una coma. Lo que no se perdona es que las palabras no
 * estén: eso es una invención, y una sugerencia inventada mueve el corte de una
 * clase a un lugar donde no se dijo nada de lo que dice que se dijo.
 *
 * @returns {number} el índice dentro de la cola, o -1
 */
function dondeEmpieza(cola, cita) {
    const plana = aplanar(cita);
    if (!plana) return -1;
    for (let i = 0; i < cola.length; i++) {
        if (aplanar(textoDe(cola.slice(i))).startsWith(plana)) return i;
    }
    return -1;
}

/**
 * La aduana: de lo que contestó el modelo sale un corte o no sale nada.
 *
 * @returns {{paredMs:number, porque:string, cita:string}|null}
 */
function validar(respuesta, previo) {
    const r = respuesta || {};
    if (r.repite !== true) return null;

    const cita = String(r.cita == null ? '' : r.cita).trim();
    // Sin un porqué que mostrar, el botón pediría aceptar a ciegas. Es lo mismo
    // que hace `lengua.validar` con su `detalle`.
    const porque = String(r.porque == null ? '' : r.porque).trim();
    if (!cita || !porque) return null;

    const cola = colaDe(previo);
    const donde = dondeEmpieza(cola, cita);
    if (donde === -1) return null;

    return { paredMs: cola[donde].t, porque, cita };
}

/* ─── El alta en el mecanismo ────────────────────────────────────────────── */

/**
 * Lo determinista de una toma: con quién empalma y cuánto se parecen los bordes.
 *
 * Es un apunte de lo que se vio, no la sugerencia: la sugerencia se rehace cada
 * vez que se mira (`paraLaPantalla`), por lo mismo que `notas-vivo.repeticiones`
 * no se guarda — el texto de una toma cambia cuando se la relee o se le mueve un
 * borde, y una sugerencia guardada envejece sin que nadie se entere. Lo que sí
 * hace falta guardar es la respuesta del modelo, porque esa se pagó.
 *
 * La toma sin cerrar no se mide: su texto es el del ciclo liviano y está
 * declarado descartable en todo el motor —se rehace entero al cerrar con el
 * modelo grande (`oir.escuchar`)—, así que un empalme medido sobre él estaría
 * mirando al transcriptor barato y cambiaría solo cuando la toma cierre.
 *
 * @param {object} toma la del estado (`engine/notas-vivo.js`)
 * @param {object} [contexto] { tomas } — las de la sesión, que es con lo único
 *   que se puede saber cuál es la anterior
 */
function medir(toma, contexto) {
    if (!toma || toma.inMs == null || toma.outMs == null) return null;
    const tomas = (contexto && contexto.tomas) || null;
    if (!tomas) return null;

    const previo = anterior(tomas, toma);
    if (!previo) return null;

    const regla = porRegla(previo, toma);
    return {
        version: VERSION,
        contra: previo.id,
        parecido: Math.round(parecidoDeLosBordes(previo, toma) * 100) / 100,
        // Si la regla ya lo resolvió, el modelo no se toca: quedó dicho acá para
        // que se pueda ver por qué esta toma no costó una consulta.
        porRegla: regla ? regla.paredMs : null
    };
}

/** ¿El editor ya dijo que no a este empalme? */
function seDescarto(toma, previo) {
    const marca = toma && toma.empalme && toma.empalme.descartado;
    return Boolean(marca && marca.contra === previo.id);
}

/**
 * Deja constancia de que el editor descartó el ajuste de este empalme.
 *
 * **Se guarda contra QUIÉN se descartó y no un simple sí.** Un booleano diría
 * "esta toma no molesta más", y eso deja de ser cierto en cuanto cambia con quién
 * empalma: si alguien descarta la toma del medio, la que pega es otra y la
 * pregunta es otra. Con el id anotado, la marca vale para el empalme que el
 * editor miró y no para el que venga después.
 *
 * Lo llama `vivo.aplicar` con el cambio `descartar-ajuste`, que es el mismo
 * camino por el que se escriben la vista, la nota y los comentarios: así el
 * descarte queda en el sidecar en el mismo gesto, sin una segunda escritura.
 */
function descartar(toma, contra) {
    toma.empalme = {
        ...(toma.empalme || {}),
        descartado: { contra: Number(contra), ms: Date.now() }
    };
}

/**
 * Lo que `engine/medir-toma.js` da de alta.
 *
 * El mecanismo pone el resto: que no haya dos consultas encimadas, que en la cola
 * espere solo la última toma, que una toma se consulte una sola vez y —lo que más
 * importa acá— que con el modelo local y la grabación en curso no se consulte
 * nada, porque sería pelearle la GPU al Whisper que decide dónde arrancan las
 * tomas (`engine/gpu.js`). Nada de eso está escrito en este archivo, y ese es el
 * punto de registrarse como un medidor más.
 *
 * **Las cuatro puertas de acá son las que hacen que esto no cueste una consulta
 * por toma**, y están ordenadas de la más barata a la más cara: sin anterior no
 * hay pregunta, un descarte del editor ya la contestó, lo que la regla resolvió
 * gratis no se paga, y lo que ni siquiera se parece no se pregunta. En una clase
 * normal casi todas las tomas salen por una de las cuatro.
 */
const medidor = {
    clave: 'empalme',
    medir,
    conModelo: async ({ toma, tomas, cliente, signal }) => {
        const previo = anterior(tomas, toma);
        if (!previo) return { hallazgos: [] };
        if (seDescarto(toma, previo)) return { hallazgos: [] };
        if (porRegla(previo, toma)) return { hallazgos: [] };
        if (parecidoDeLosBordes(previo, toma) < PARECIDO_PARA_PREGUNTAR) return { hallazgos: [] };

        // El límite propio va aparte del `signal` de quien llama, y se recuerda
        // cuál de los dos disparó: los clientes contestan "cancelado" a cualquier
        // aborto, y decir "cancelado" cuando lo que pasó es que el modelo tardó
        // de más es decir algo que no pasó.
        let porTiempo = false;
        const limite = AbortSignal.timeout(LIMITE_MS);
        limite.addEventListener('abort', () => { porTiempo = true; }, { once: true });

        const respuesta = await cliente.ask({
            system: SYSTEM,
            prompt: prompt(previo, toma),
            numPredict: 500,
            signal: signal ? AbortSignal.any([signal, limite]) : limite
        });

        if (respuesta && respuesta.error) {
            return {
                error: porTiempo
                    ? `el modelo no contestó en ${Math.round(LIMITE_MS / 1000)} s`
                    : respuesta.error
            };
        }

        const leido = validar(respuesta, previo);
        // Se guarda el corte y el porqué, no la sugerencia entera: la sugerencia
        // se rehace al mirarla, contra las palabras de ese momento.
        return {
            hallazgos: leido
                ? [{ contra: previo.id, origen: 'modelo', paredMs: leido.paredMs, porque: leido.porque, cita: leido.cita }]
                : []
        };
    }
};

/* ─── Lo que ve la pantalla ──────────────────────────────────────────────── */

/**
 * El empalme de una toma, tal como se dibuja: con quién pega, qué se subraya y
 * qué hacen los dos botones.
 *
 * **Se rehace en cada lectura y no se guarda**, igual que `repeticiones` en
 * `notas-vivo.js` y por el mismo motivo: es lo que hace que una sugerencia no
 * pueda quedar hablando de algo que ya no existe. Los tres casos que rompen una
 * sugerencia guardada se resuelven solos acá, sin código para cada uno:
 *
 * - Se aceptó el ajuste: la anterior perdió esa cola, la palabra del corte ya no
 *   está en ella y `armarSugerencia` devuelve null.
 * - Se descartó una toma del medio: `anterior` contesta otra, el `contra` de lo
 *   guardado no coincide y la respuesta del modelo no se usa.
 * - La toma se releyó con el modelo grande y el texto cambió: se vuelve a mirar
 *   contra las palabras nuevas.
 *
 * Lo único que se lee de lo guardado es lo que se pagó —la respuesta del modelo—
 * y aun eso pasa otra vez por la aduana antes de mostrarse.
 *
 * @returns {object|null} null cuando no hay empalme que mirar (la primera toma,
 *   una descartada, una sin cerrar)
 */
function paraLaPantalla(toma, tomas) {
    if (!toma || toma.outMs == null || toma.descartada) return null;
    const previo = anterior(tomas, toma);
    if (!previo) return null;

    const ia = (toma.empalme && toma.empalme.ia) || null;
    const vista = {
        contra: previo.id,
        parecido: Math.round(parecidoDeLosBordes(previo, toma) * 100) / 100,
        // 'listo' cuando hay algo que decir o cuando ya se miró y no había nada;
        // los demás son los del mecanismo ('midiendo', 'falla', 'sin-modelo',
        // 'abstenido') y 'descartado', que es de acá.
        estado: ia ? ia.estado : 'sin-medir',
        porque: ia ? ia.porque : '',
        sugerencia: null
    };

    if (seDescarto(toma, previo)) {
        vista.estado = 'descartado';
        vista.porque = 'Descartaste el ajuste de este empalme.';
        return vista;
    }

    const regla = porRegla(previo, toma);
    if (regla) {
        vista.sugerencia = armarSugerencia(previo, toma, regla.paredMs, 'regla',
            `La toma ${toma.id} arranca diciendo otra vez lo que la ${previo.id} ya decía al final.`);
        if (vista.sugerencia) {
            // La regla no necesitó modelo: el bloque está resuelto aunque la
            // consulta esté en camino o se haya caído.
            vista.estado = 'listo';
            vista.porque = '';
            return vista;
        }
    }

    const guardada = ((ia && ia.hallazgos) || []).find(h => h && h.contra === previo.id);
    if (guardada) {
        vista.sugerencia = armarSugerencia(previo, toma, guardada.paredMs, 'modelo', guardada.porque);
    }
    return vista;
}

module.exports = {
    VERSION,
    COLA_PALABRAS,
    CABEZA_PALABRAS,
    MINIMO_PALABRAS,
    MINIMO_RECORTE_MS,
    MINIMO_QUEDA_MS,
    PARECIDO_PARA_PREGUNTAR,
    LIMITE_MS,
    SYSTEM,
    medidor,
    anterior,
    colaDe,
    cabezaDe,
    parecidoDeLosBordes,
    porRegla,
    armarSugerencia,
    prompt,
    validar,
    medir,
    descartar,
    paraLaPantalla
};
