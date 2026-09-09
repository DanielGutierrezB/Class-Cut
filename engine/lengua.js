'use strict';
/**
 * lengua.js — Cómo viene hablando el profesor, toma por toma y en vivo.
 *
 * El lector de esto es el profesor MIENTRAS graba, y eso decide todo lo demás:
 * no es un informe para archivar, es una señal para corregir el rumbo en la toma
 * que sigue. De ahí las tres reglas que se siguieron acá:
 *
 * **Lo barato y lo caro van separados, y no se mezclan nunca.** Las tres medidas
 * de arriba —muletillas, ritmo y aire muerto— se calculan sobre las palabras que
 * ya están en memoria: son instantáneas, no cuestan una consulta y no pueden
 * fallar. Las tres de abajo necesitan un modelo, tardan segundos y pueden volver
 * mal o no volver. Mezclarlas dejaría el panel entero apagado cada vez que se
 * cae lo caro, que es exactamente lo que no puede pasar mientras se graba.
 *
 * **Un número sin referencia no dice nada.** "168 palabras por minuto" no le
 * sirve a nadie; "venís en zona" o "venís muy rápido", sí. Las bandas de
 * `BANDAS` salen de medir las trece clases del curso con `tools/medir-lengua.js`
 * y no de estimarlas, y cada una dice de dónde salió su número.
 *
 * **Las tasas se agregan, los hechos no.** Muletillas por minuto, ritmo y aire
 * muerto son tasas: sumar palabras y sumar segundos de toda la clase da una tasa
 * más firme que la de una toma suelta, así que esas se muestran sobre la clase
 * que va a quedar. Una frase que quedó colgando, en cambio, es un hecho de UNA
 * toma: agregarla daría un contador que solo sube y que a la media hora está
 * siempre en rojo, o sea ruido. Esas se muestran de la última toma.
 *
 * **Sin estado, sin DOM y sin disco**: todo lo de acá se prueba solo
 * (`tests/lengua.test.js`). Quien lo llama cuando una toma queda cerrada es
 * `engine/medir-toma.js`.
 */

const { HUECO_SEC } = require('./oir');

/** 1: primera versión. Va guardada en cada toma para poder releer lo viejo. */
const VERSION = 1;

/**
 * Las muletillas que se cuentan, y por qué justo estas.
 *
 * Medido sobre las 44.891 palabras del curso (`tools/medir-lengua.js`), y de ahí
 * salen tanto las que están como las que se dejaron afuera:
 *
 * - **"o sea" es la única que aparece de verdad**: 93 veces, casi tanto como todas
 *   las demás juntas. A veces encadena una explicación legítima —"o sea, lo que pasa
 *   es que…"— y se cuenta igual, porque lo que se mide es una TASA y no un
 *   veredicto sobre cada aparición: decirlo dos veces en una clase no mueve el
 *   número, decirlo ocho veces por minuto sí. El margen de error se paga acá.
 *
 * - **"este", "nada" y "tipo" son palabras normales** y por eso solo se cuentan
 *   cuando quedan sueltas, o sea con puntuación detrás. La diferencia no es
 *   sutil: "este" aparece 265 veces en el curso y solo 10 con una coma detrás —
 *   las otras 255 son "este curso", "este problema", "este tipo de". Contándolo
 *   crudo, la medida sería un contador de demostrativos. Con la coma quedan 10,
 *   de los cuales alguno todavía es legítimo ("los documentos para, nada"): el
 *   error residual es de unas pocas apariciones en trece clases, y se prefiere
 *   eso a tapar el problema no contándolas.
 *
 * - **"bueno", "entonces", "claro" y "es decir" quedaron afuera** aunque en el
 *   curso aparecen 116, 151, 37 y 11 veces. No son muletillas: son cómo se abre
 *   una toma ("Bueno, arrancamos") y cómo se enlaza una idea con la anterior. Si
 *   entraran, "bueno" sería la segunda muletilla más frecuente del curso y el
 *   panel estaría siempre avisando de que el profesor habla como un profesor.
 *
 * **Lo que esto NO mide, y hay que saberlo:** las vacilaciones puramente
 * vocálicas. Whisper no las escribe —"eh" aparece 19 veces en siete horas de
 * audio, y quien haya oído la clase sabe que se dijo muchas más—, así que este
 * número es un piso y no la verdad. Lo que se mide son muletillas LÉXICAS, las
 * que el transcriptor sí escribe.
 */
const SUELTAS = ['eh', 'ehh', 'ehm', 'em', 'este', 'nada', 'tipo', 'digamos',
    'basicamente', 'obviamente'];

/** Las de dos palabras, que en el río de tokens de Whisper llegan partidas. */
const PAREJAS = ['o sea', 'como que', 'digamos que', 'por asi decirlo'];

/**
 * Las coletillas de pedir acuerdo, que en rioplatense son media conversación.
 *
 * Se piden CON el signo de pregunta porque es lo único que las separa de la
 * palabra: "no" y "sí" se dicen todo el tiempo, "¿no?" y "¿viste?" no.
 */
const COLETILLAS = /^(no|si|viste|cierto|entendes)$/;

/**
 * Texto comparable, pero con los espacios puestos.
 *
 * No se usa `texto.norm` —que es la de comparar arranques de tomas— porque esa
 * saca TODO lo que no sea letra o número, espacios incluidos: "o sea" quedaría
 * en "osea" y coincidiría dentro de "ósea", y una cita del modelo pegada en una
 * sola palabra coincidiría en cualquier parte. Acá hacen falta las fronteras.
 */
function aplanar(texto) {
    return String(texto == null ? '' : texto)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9ñ]+/g, ' ')
        .trim();
}

/** ¿La palabra viene con puntuación detrás? Es lo que la deja "suelta". */
function quedaSuelta(texto) {
    return /[.,;:…!]["')]?$/.test(String(texto == null ? '' : texto));
}

/** ¿Es una coletilla? Pide el signo puesto, que es lo que la hace coletilla. */
function esColetilla(texto) {
    const bruta = String(texto == null ? '' : texto).trim();
    return /\?["')]?$/.test(bruta) && COLETILLAS.test(aplanar(bruta));
}

/**
 * Las muletillas que hay en una tirada de palabras.
 *
 * Devuelve también CUÁLES, y no solo cuántas: un número de muletillas sin la
 * lista no se puede discutir, y la primera pregunta de quien lo ve va a ser
 * "¿cuáles?". Es también lo que deja ver de un vistazo si la medida se equivocó.
 *
 * @param {Array} palabras [{t, texto}]
 * @returns {{cuantas:number, cuales:Array<string>}}
 */
function muletillasEn(palabras) {
    const lista = palabras || [];
    const cuales = [];

    for (let i = 0; i < lista.length; i++) {
        const bruta = lista[i] && lista[i].texto;
        const p = aplanar(bruta);
        if (!p) continue;

        if (esColetilla(bruta)) {
            cuales.push(p);
            continue;
        }

        // Las de dos palabras primero: "digamos que" es una sola muletilla y no
        // un "digamos" seguido de algo, y contarla dos veces duplicaría la tasa.
        const par = i + 1 < lista.length ? `${p} ${aplanar(lista[i + 1].texto)}` : '';
        if (PAREJAS.includes(par)) {
            cuales.push(par);
            i++;
            continue;
        }

        if (SUELTAS.includes(p) && quedaSuelta(bruta)) cuales.push(p);
    }

    return { cuantas: cuales.length, cuales };
}

/**
 * Los segundos de la toma en los que no se dijo nada.
 *
 * **Se reusa el listón de `oir.HUECO_SEC`, que son 2,5 s.** Es el mismo número
 * con el que el motor decide que un hueco entre dos palabras merece mirarse, y
 * el mismo con el que `silencios.js` le avisa al editor en post: si acá hubiera
 * otro, la misma pausa sería aire muerto para el panel y una pausa normal para
 * el resto de la app. Por debajo de eso no hay nada que avisar — respirar,
 * pensar y dejar que algo se entienda son pausas de clase.
 *
 * **Y no se vuelve a leer la onda.** El detector de voz ya corrió: las palabras
 * de una toma cerrada pasaron por `oir.rellenarHuecos`, que mira el mapa de
 * `voz.deLaClase` y relee todo hueco con voz sostenida adentro. O sea que para
 * cuando esto las ve, un hueco que tenía habla ya no es un hueco: tiene las
 * palabras que faltaban. Volver a abrir el WAV para levantar otro mapa serían
 * tres décimas de CPU y un mapa más en memoria en medio de una grabación, para
 * mirar lo que otro ya miró.
 *
 * Los bordes cuentan: una toma que el botón cerró veinte segundos después de la
 * última palabra tiene veinte segundos de aire, y son los que el editor va a
 * tener que recortar.
 */
function aireSec(palabras, inMs, outMs) {
    const lista = palabras || [];
    if (inMs == null || outMs == null) return 0;

    let aire = 0;
    let previo = inMs;
    for (const w of lista) {
        if (w.t - previo >= HUECO_SEC * 1000) aire += (w.t - previo) / 1000;
        previo = w.t;
    }
    if (outMs - previo >= HUECO_SEC * 1000) aire += (outMs - previo) / 1000;
    return aire;
}

/**
 * Cuántos segundos de la toma se pasaron hablando.
 *
 * Es el largo de la toma menos su aire muerto, y esa resta es a propósito: el
 * ritmo tiene que medirse contra el tiempo en que se habló y no contra el reloj.
 * Si se midiera contra el reloj, una toma en la que el profesor habla rapidísimo
 * y se queda callado medio minuto daría un ritmo "sano" por promedio, y las dos
 * cosas que pasaron —habla muy rápido, se calla mucho— se taparían entre sí. Con
 * la resta, cada medida mira su lado y las dos son accionables por separado.
 */
function hablandoSec(palabras, inMs, outMs) {
    if (inMs == null || outMs == null) return 0;
    return Math.max(0, (outMs - inMs) / 1000 - aireSec(palabras, inMs, outMs));
}

/**
 * Cuánto tiene que haber hablado una toma para darle una tasa propia.
 *
 * Una tasa por minuto sobre quince segundos es una extrapolación: una sola
 * muletilla en ese rato ya se lee como cuatro por minuto, y el profesor vería un
 * número alarmante por haber dicho "o sea" una vez. Con veinte segundos —unas
 * cincuenta y cinco palabras al ritmo del curso— el ritmo queda firme, y la tasa
 * de muletillas sigue siendo gruesa: por eso la que se muestra en el panel es la
 * de la clase, que junta palabras y segundos de todas las tomas.
 *
 * Una toma más corta que esto no se queda sin medir: sus palabras y sus segundos
 * entran igual al agregado. Lo único que no tiene es tasa propia.
 */
const MINIMO_SEC = 20;

/**
 * Las bandas: qué es estar en zona, y de dónde sale cada número.
 *
 * Todo lo de acá se midió con `tools/medir-lengua.js` sobre las trece clases del
 * curso de spec-driven, que son las únicas trece clases de verdad que hay. Es la
 * misma regla que el resto del motor: los números que deciden se miden.
 *
 * **Y son de ESTE profesor.** Un profesor que habla más despacio quedaría
 * avisado todo el tiempo con la banda de abajo. Cuando haya un segundo curso,
 * esto se vuelve a medir; lo que no se puede es inventar una banda "universal" y
 * hacerla pasar por medida.
 */
const BANDAS = {
    /**
     * 150 a 200 palabras por minuto DE HABLA.
     *
     * De los 82 bloques que quedaron en el corte final del curso —material que un
     * editor humano miró y dio por bueno—, el 5% más lento va a 148 y el 5% más
     * rápido a 197, con la mediana en 172. Sobre el material crudo, partido en
     * 271 tiradas de habla de 25 s o más, la mediana es 164, el decil de arriba
     * pasa 189 y el 5% de arriba, 202. La banda es el solape de las dos, así que
     * deja afuera cerca de una toma de cada diez por cada lado: la frecuencia
     * justa para una señal que no puede volverse ruido.
     *
     * Es más rápido que el "130 a 160" que se cita para español hablado, y con
     * razón: eso describe una charla, y una clase grabada que se va a cortar es
     * habla eficiente y ensayada. La referencia buena es el curso, no el manual.
     */
    ppm: { desde: 150, hasta: 200 },

    /**
     * Hasta 2 muletillas por minuto de habla.
     *
     * Sobre las 271 tiradas del curso crudo, la mediana es CERO —o sea que la
     * mayoría de las tomas no tiene ninguna— y el decil de arriba pasa 2,4. En
     * los 82 bloques del corte final no hay ni una, que es lo esperable: son las
     * tomas buenas. El listón en 2 es ese decil de arriba: el mismo criterio de
     * "una toma de cada diez" que el ritmo.
     */
    muletillasPorMin: { hasta: 2 },

    /**
     * Hasta el 10% de la toma en aire muerto.
     *
     * Medido con el mapa de voz de verdad —no con los huecos del transcript, que
     * mienten cuando Whisper se come una palabra— sobre los 161 bloques del corte
     * final: la mediana es cero, el decil de arriba pasa el 4,8% y el 5% de
     * arriba, el 11,2%. El 10% cae entre esos dos, y en una toma de un minuto son
     * seis segundos: lo bastante como para que se note al verla y lo bastante poco
     * como para que no salte por una pausa de las que se hacen a propósito.
     */
    airePct: { hasta: 10 }
};

/**
 * En qué zona cae un valor: 'bien', 'ojo', o nada si no hay valor.
 *
 * Dos zonas y no tres. Un semáforo de tres colores obliga a decidir dónde
 * termina el amarillo y empieza el rojo, y eso no está medido: lo que está
 * medido es dónde está el decil de afuera. Con dos, lo que el panel afirma es
 * exactamente lo que se midió.
 */
function zona(clave, valor) {
    const banda = BANDAS[clave];
    if (!banda || valor == null || !Number.isFinite(valor)) return null;
    if (banda.desde != null && valor < banda.desde) return 'ojo';
    if (banda.hasta != null && valor > banda.hasta) return 'ojo';
    return 'bien';
}


/* ─── Lo determinista ─────────────────────────────────────────────────────── */

/**
 * Mide una toma cerrada con lo que ya está en memoria.
 *
 * No falla nunca y no pide nada: es la mitad del bloque que tiene que andar
 * siempre, haya o no proveedor de IA configurado.
 *
 * Una toma sin cerrar no se mide, y es una decisión: su texto es el del ciclo de
 * señales, el liviano, y ese texto está declarado descartable en todo el motor —
 * se rehace entero al cerrar con el modelo grande (`oir.escuchar`). Contar
 * muletillas sobre él sería medir al transcriptor barato y no al profesor, y el
 * número cambiaría solo cuando la toma cierre sin que nadie haya hecho nada.
 * Mejor no decir nada que decir un número que se va a desdecir.
 *
 * @param {object} toma la del estado (`engine/notas-vivo.js`)
 * @returns {object|null} null si la toma no cerró
 */
function medir(toma) {
    if (!toma || toma.inMs == null || toma.outMs == null) return null;

    const palabras = toma.palabras || [];
    const duracionSec = (toma.outMs - toma.inMs) / 1000;
    const aire = aireSec(palabras, toma.inMs, toma.outMs);
    const habla = Math.max(0, duracionSec - aire);
    const { cuantas, cuales } = muletillasEn(palabras);

    return {
        version: VERSION,
        palabras: palabras.length,
        duracionSec: Math.round(duracionSec * 10) / 10,
        hablandoSec: Math.round(habla * 10) / 10,
        aireSec: Math.round(aire * 10) / 10,
        muletillas: cuantas,
        cuales,
        // Las tasas propias solo si hubo con qué (ver `MINIMO_SEC`). La toma
        // corta entra al agregado igual: lo que no tiene es tasa propia.
        ppm: habla >= MINIMO_SEC ? Math.round(palabras.length / (habla / 60)) : null,
        muletillasPorMin: habla >= MINIMO_SEC
            ? Math.round(cuantas / (habla / 60) * 10) / 10
            : null,
        airePct: duracionSec > 0 ? Math.round(aire / duracionSec * 1000) / 10 : null
    };
}

/* ─── Lo que pide un modelo ───────────────────────────────────────────────── */

/**
 * Los tres tipos de hallazgo que se aceptan.
 *
 * Son tres y no ocho porque el lector está grabando: seis filas son las que se
 * pueden mirar sin frenar la clase, y una lista de ocho cosas para revisar es
 * una lista que no se lee.
 *
 * Acá viven las claves y nada más — cómo se llama cada una en pantalla es del
 * panel, que es el único que muestra texto. Con el rótulo escrito de los dos
 * lados, cambiarlo en uno dejaría la fila diciendo una cosa y el registro otra.
 */
const TIPOS = ['sin_cerrar', 'repetida', 'jerga'];

const SYSTEM = 'Sos un editor que escucha UNA toma de una clase grabada, en español. ' +
    'Marcás solo lo que un alumno no va a poder seguir. ' +
    'Respondés SIEMPRE solo JSON válido, en español.';

/**
 * La consulta de una toma: una sola, con los tres tipos juntos.
 *
 * **Una llamada por toma y no una por tipo.** Son tres preguntas sobre el mismo
 * texto de sesenta segundos, y partirlas en tres consultas triplicaría la espera
 * y el gasto para leer lo mismo tres veces. Además el modelo necesita ver la toma
 * entera para las tres: una frase que queda colgando se ve porque lo que sigue
 * arranca en otra cosa.
 *
 * **Se le pide que CITE.** Cada hallazgo tiene que traer las palabras tal como se
 * dijeron, y `validar` tira el que cite algo que en la toma no está. Es la misma
 * defensa que usa `coherence.js` pidiendo números de bloque: sin un ancla
 * verificable, un modelo que alucina un problema lo pone en pantalla igual, y en
 * un panel en vivo eso mandaría al profesor a arreglar algo que no dijo.
 *
 * De la repetición: se le pide DENTRO de la toma y nada más. Que una toma repita
 * el arranque de otra ya lo dice el estado por su cuenta y sin modelo
 * (`repeticiones` en `notas-vivo.js`, que es el `repiteA` de cada toma), así que
 * preguntarlo acá sería pagar por lo que ya se sabe y decirlo dos veces en la
 * misma pantalla. Lo que ahí no se ve es el profesor que explica lo mismo dos
 * veces con otras palabras adentro de la misma toma, y eso es esto.
 */
function prompt(toma) {
    return `Esta es UNA toma de una clase: un tramo que el profesor grabó de corrido y ya cerró.

TOMA:
${textoDe(toma)}

Leela como el alumno que va a ver la clase y marcá SOLO lo que de verdad no se entiende:

- sin_cerrar: se arranca una frase o una idea y se abandona — un arranque que no llega a ninguna parte, una autocorrección a mitad de camino, algo que queda colgando.
- repetida: la misma idea se explica dos veces DENTRO de esta toma, con otras palabras. Reformular una vez para que se entienda no cuenta: es cómo se enseña. Cuenta cuando se está dando vueltas.
- jerga: un término técnico o un anglicismo se usa sin explicarlo y sin él no se sigue la clase. Los términos que ya se explicaron antes en la toma no cuentan.

Si la toma se entiende bien, devolvé la lista vacía. No comentes el estilo ni inventes problemas.

En "que" van las palabras TAL COMO SE DICEN en la toma, copiadas: si no están en el texto de arriba, el hallazgo se descarta.

Responde solo JSON:
{"hallazgos": [{"tipo": "<sin_cerrar|repetida|jerga>", "que": "<las palabras copiadas de la toma>", "detalle": "<qué no cierra, en una frase>"}]}`;
}

/** El texto de la toma, de corrido, que es lo que el modelo lee. */
function textoDe(toma) {
    return (toma && toma.palabras || []).map(w => String(w.texto || '').trim())
        .filter(Boolean).join(' ');
}

/**
 * Cuántos hallazgos de cada tipo se guardan.
 *
 * Un modelo hablador puede devolver quince "sin_cerrar" en una toma de un
 * minuto, y quince filas en un panel en vivo no son información: son una pared.
 * Tres por tipo alcanzan para saber que la toma tuvo un problema y cuál fue.
 */
const MAXIMO_POR_TIPO = 3;

/**
 * Solo sobrevive el hallazgo que cita algo que se dijo de verdad.
 *
 * La cita se compara aplanada —sin acentos, sin signos y con los espacios
 * normalizados— porque el modelo repuntúa lo que copia: pedir coincidencia
 * exacta tiraría hallazgos buenos por una coma. Lo que no se perdona es que las
 * palabras no estén: eso es una invención, y en vivo una invención manda al
 * profesor a corregir algo que no pasó.
 *
 * @param {object} respuesta lo que devolvió `ask`
 * @param {object} toma la toma que se preguntó
 * @returns {Array} los hallazgos que se pueden creer
 */
function validar(respuesta, toma) {
    const dicho = aplanar(textoDe(toma));
    const cuantos = {};
    const buenos = [];

    for (const item of (respuesta && respuesta.hallazgos) || []) {
        const tipo = item && TIPOS.includes(item.tipo) ? item.tipo : null;
        if (!tipo) continue;

        const cita = String(item.que || '').trim();
        const plana = aplanar(cita);
        if (!plana || !dicho.includes(plana)) continue;

        const detalle = String(item.detalle || '').trim();
        if (!detalle) continue;

        cuantos[tipo] = (cuantos[tipo] || 0) + 1;
        if (cuantos[tipo] > MAXIMO_POR_TIPO) continue;
        buenos.push({ tipo, que: cita, detalle });
    }
    return buenos;
}

/** Cuántos hallazgos de cada tipo, que es lo que el panel muestra en su fila. */
function porTipo(hallazgos) {
    const cuenta = {};
    for (const tipo of TIPOS) cuenta[tipo] = 0;
    for (const h of hallazgos || []) cuenta[h.tipo]++;
    return cuenta;
}

/* ─── La clase entera ─────────────────────────────────────────────────────── */

/**
 * Lo que el panel muestra: las tasas de la clase que va a quedar, y los hechos
 * de la última toma.
 *
 * **Una toma descartada no cuenta, y por eso la medida vive en la toma.** El
 * número que ve el profesor tiene que ser el de la clase que va a quedar, no el
 * de todo lo que se grabó: si se descartara del agregado, descartar una toma ya
 * medida dejaría el número mintiendo hasta la próxima medición. Guardando la
 * medida en cada toma y filtrando acá, descartar es instantáneo y reversible —
 * volver a incluirla la trae de vuelta con su medida intacta, sin releer nada.
 * Es la misma forma en que `tomasQueQuedan` decide qué va al XML.
 *
 * @param {Array} tomas las del estado, con su `lengua` puesta
 */
function agregado(tomas) {
    const lista = tomas || [];
    const medidas = lista.filter(t => !t.descartada && t.lengua && t.lengua.det);

    const suma = medidas.reduce((a, t) => ({
        palabras: a.palabras + t.lengua.det.palabras,
        hablandoSec: a.hablandoSec + t.lengua.det.hablandoSec,
        aireSec: a.aireSec + t.lengua.det.aireSec,
        duracionSec: a.duracionSec + t.lengua.det.duracionSec,
        muletillas: a.muletillas + t.lengua.det.muletillas
    }), { palabras: 0, hablandoSec: 0, aireSec: 0, duracionSec: 0, muletillas: 0 });

    const minutos = suma.hablandoSec / 60;
    // La última de la que el modelo YA HABLÓ, y que además siga en pie.
    //
    // Son dos filtros y los dos hacen falta. Si la toma de recién se descartó, lo
    // que hay que mirar es la anterior: la descartada no puede encabezar el panel
    // más de lo que puede contar. Y si la de recién todavía se está midiendo
    // —cosa que con el proveedor de esta Mac dura dos minutos—, mostrarla como
    // "la última" dejaría las tres filas de abajo en un guion permanente: la más
    // nueva siempre está en camino. Lo último que el modelo dijo, con el número
    // de su toma al lado, es información; un guion eterno no.
    const contestadas = medidas.filter(t => contesto(t.lengua.ia));
    const ultima = contestadas.length ? contestadas[contestadas.length - 1] : null;
    const enCamino = medidas.find(t => t.lengua.ia && t.lengua.ia.estado === 'midiendo');

    return {
        version: VERSION,
        tomas: medidas.length,
        // Cuántas cerraron y todavía no se midieron: es lo que explica un panel
        // vacío con tomas en la lista, en vez de dejarlo pareciendo roto.
        sinMedir: lista.filter(t => !t.descartada && t.outMs != null && !(t.lengua && t.lengua.det)).length,
        abierta: lista.some(t => t.outMs == null),
        palabras: suma.palabras,
        hablandoSec: Math.round(suma.hablandoSec),
        aireSec: Math.round(suma.aireSec),
        // Las tasas piden el mismo mínimo que una toma suelta: sobre los primeros
        // diez segundos de la clase, cualquier tasa es una anécdota.
        ppm: suma.hablandoSec >= MINIMO_SEC ? Math.round(suma.palabras / minutos) : null,
        muletillasPorMin: suma.hablandoSec >= MINIMO_SEC
            ? Math.round(suma.muletillas / minutos * 10) / 10
            : null,
        airePct: suma.duracionSec > 0
            ? Math.round(suma.aireSec / suma.duracionSec * 1000) / 10
            : null,
        muletillas: suma.muletillas,
        // Las que más se dijeron, para poder contestar "¿cuáles?" sin abrir nada.
        masDichas: masDichas(medidas),
        ultima: ultima ? { toma: ultima.id, ...ultima.lengua } : null,
        // Qué toma está en el modelo ahora mismo, para poder decir "esperá" en vez
        // de dejar el panel quieto y que parezca que ya terminó de mirar.
        midiendo: enCamino ? enCamino.id : null,
        // En qué zona cae cada tasa, decidido acá y no en la pantalla. La ventana
        // no importa módulos del motor —habla solo por el puente— así que si la
        // comparación se hiciera allá, las bandas estarían escritas dos veces y
        // la próxima corrección se haría en una sola. Es el mismo problema que
        // tuvieron los colores de las vistas (ver `tests/colores.test.js`).
        zonas: zonasDe(suma, minutos),
        // Y la banda misma, para poder decir CONTRA QUÉ está en zona: sin eso el
        // panel afirma "vas bien" sin decir qué es bien.
        bandas: BANDAS
    };
}

/**
 * ¿El modelo ya dijo lo suyo de esta toma?
 *
 * Una falla, un "no hay proveedor" y un "no se consulta mientras se graba"
 * cuentan como contestados: los tres son algo que el panel puede decir. Lo que
 * no cuenta es 'midiendo' —todavía no dijo nada— ni la toma sin estado, que es
 * la que el carril desplazó por una más nueva.
 *
 * Que 'abstenido' entre es lo que hace que el bloque hable en la única
 * configuración en que nunca hay una toma leída: con el modelo local y la clase
 * en curso, dejarlo afuera dejaba las tres filas de abajo en guiones sin una
 * palabra que explicara por qué (`engine/gpu.js`).
 */
function contesto(ia) {
    return Boolean(ia && ['listo', 'falla', 'sin-modelo', 'abstenido'].includes(ia.estado));
}

function zonasDe(suma, minutos) {
    const ppm = minutos > 0 ? suma.palabras / minutos : null;
    const mule = minutos > 0 ? suma.muletillas / minutos : null;
    const aire = suma.duracionSec > 0 ? suma.aireSec / suma.duracionSec * 100 : null;
    return {
        ppm: suma.hablandoSec >= MINIMO_SEC ? zona('ppm', ppm) : null,
        muletillasPorMin: suma.hablandoSec >= MINIMO_SEC ? zona('muletillasPorMin', mule) : null,
        airePct: zona('airePct', aire)
    };
}

/** Las tres muletillas más dichas de la clase, de la que más a la que menos. */
function masDichas(medidas) {
    const cuenta = new Map();
    for (const t of medidas) {
        for (const cual of t.lengua.det.cuales || []) {
            cuenta.set(cual, (cuenta.get(cual) || 0) + 1);
        }
    }
    return [...cuenta.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cual, veces]) => ({ cual, veces }));
}

/* ─── El alta en el mecanismo ─────────────────────────────────────────────── */

/**
 * Cuánto se le espera al modelo por una toma.
 *
 * Este número se midió, y la primera versión estaba mal. Se había puesto en 45 s
 * razonando que un número que llega tarde no sirve; corriéndolo de verdad contra
 * el proveedor de esta Mac —`claude-sonnet-5-thinking-high` por el Cursor CLI—
 * las tomas del curso tardaron entre 7 y 127 segundos, y las tres de la primera
 * corrida cayeron del lado malo: volvían todas con "no contestó". Lo que enseña
 * la variación es que un límite ajustado no recorta la espera, tira la respuesta.
 *
 * Así que son dos minutos y medio, que es lo que el proveedor configurado
 * necesita, y el atraso se maneja en el otro lado: el carril de `medir-toma.js`
 * deja esperando solo a la última toma, así que la respuesta que llega es siempre
 * sobre lo último que se grabó y no sobre lo de hace veinte minutos. Y lo que se
 * lee de un vistazo entre dos tomas —muletillas, ritmo, aire— no espera a nadie.
 *
 * Con un modelo sin "thinking" esto contestaría en segundos, pero cuál usar es
 * una decisión del editor en Ajustes y no de este archivo: acá lo que se hace es
 * aguantar el que haya, no elegirlo por él.
 */
const LIMITE_MS = 150000;

/**
 * Debajo de esto no se consulta.
 *
 * En treinta palabras no hay una idea que pueda quedar colgando ni una
 * explicación que se dé dos veces, así que la consulta se pagaría para contestar
 * que no hay nada. Las tomas cortas existen y son normales: el profesor arranca,
 * no le sale, y vuelve a contar.
 */
const MINIMO_PALABRAS = 30;

/**
 * Lo que `engine/medir-toma.js` da de alta: la mitad barata y la mitad cara.
 *
 * El mecanismo garantiza que no haya dos consultas encimadas y que una toma se
 * consulte una sola vez; acá vive nada más que qué se le pregunta y cómo se lee
 * lo que contesta.
 */
const medidor = {
    clave: 'lengua',
    medir,
    conModelo: async ({ toma, cliente, signal }) => {
        if ((toma.palabras || []).length < MINIMO_PALABRAS) return { hallazgos: [] };

        // El límite propio va aparte del `signal` de quien llama, y se recuerda
        // cuál de los dos disparó: los clientes contestan "cancelado" a cualquier
        // aborto, y decirle al profesor "cancelado" cuando lo que pasó es que el
        // modelo tardó de más es decirle algo que no pasó.
        let porTiempo = false;
        const limite = AbortSignal.timeout(LIMITE_MS);
        limite.addEventListener('abort', () => { porTiempo = true; }, { once: true });

        const respuesta = await cliente.ask({
            system: SYSTEM,
            prompt: prompt(toma),
            numPredict: 600,
            signal: signal ? AbortSignal.any([signal, limite]) : limite
        });

        if (respuesta && respuesta.error) {
            return {
                error: porTiempo
                    ? `el modelo no contestó en ${Math.round(LIMITE_MS / 1000)} s`
                    : respuesta.error
            };
        }
        return { hallazgos: validar(respuesta, toma) };
    }
};

module.exports = {
    VERSION,
    BANDAS,
    LIMITE_MS,
    MINIMO_PALABRAS,
    medidor,
    MINIMO_SEC,
    MAXIMO_POR_TIPO,
    SUELTAS,
    PAREJAS,
    TIPOS,
    SYSTEM,
    aplanar,
    muletillasEn,
    aireSec,
    hablandoSec,
    medir,
    zona,
    prompt,
    textoDe,
    validar,
    porTipo,
    agregado
};
