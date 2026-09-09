'use strict';
/**
 * oir.js — Transcribir un pedazo de lo que se está capturando.
 *
 * Dos usos distintos y un solo camino, porque el que ya está probado es este:
 * recortar el WAV con ffmpeg y pasarle el recorte a `whisper-cli` con las
 * banderas que el motor usa en post (`transcribe.runWhisper`). No hay
 * transcripción en streaming acá, y es una decisión:
 *
 * **Por qué por pedazos y no en continuo.** Whisper en streaming va escribiendo
 * y corrigiendo lo que ya escribió, y de ahí no sale un transcript con tiempos
 * confiables por palabra. Medido con nuestro binario sobre el curso real, un
 * recorte tarda 1,14 s si trae 10 s de audio y 1,25 s si trae 20: casi todo es
 * cargar el modelo, así que el largo no importa. Y lo que de verdad permite
 * hacerlo así es que **la latencia no perjudica la precisión**: cuando el
 * profesor dice "Pausa", el OUT se pone en el timecode de esa palabra, no en el
 * momento en que la herramienta se enteró.
 *
 * **Los dos ciclos.** El de señales corre seguido con un modelo liviano y su
 * texto se tira: solo sirve para ver si alguien dijo "3, 2, 1" o "Pausa". El de
 * toma corre una vez, al cerrar, con el modelo grande, y ESE texto es el que
 * queda. Así el transcript nunca se arma de pedazos pegados, que es de donde
 * salen las palabras cortadas y los tiempos que no cierran.
 *
 * La única excepción a lo de no pegar pedazos es `rellenarHuecos`, y está ahí
 * porque la pasada grande se come tramos enteros de habla —los que están en otro
 * idioma— sin dejar rastro de que lo hizo.
 */

const paths = require('./paths');
const captura = require('./captura');
const rescate = require('./rescate');
const transcribe = require('./transcribe');
const voz = require('./voz');

/**
 * Cuánto tiene que durar un hueco entre dos palabras para mirarlo, y cuánta voz
 * sostenida tiene que haber adentro para volver a leerlo. El mismo número para
 * las dos cosas: un hueco de tres segundos con tres segundos de voz es alguien
 * hablando sin que nadie lo escribiera, y ahí no hay nada que dudar.
 */
const HUECO_SEC = 2.5;

/** Aire a cada lado del sonido que se relee. */
const CONTEXTO_SEC = 0.4;

/**
 * ¿Está escrito con nuestro alfabeto?
 *
 * Sobre un pedazo corto donde alguien masculla, whisper.cpp puede salir por un
 * alfabeto que no es el del curso: en la clase 8 escribió "뒤에 가려…" sobre siete
 * segundos. Pedirle el idioma del curso lo evita en ese caso concreto, pero no
 * es una garantía, y un guion en coreano en medio de una clase en español no es
 * algo que valga la pena arriesgar por dos líneas. Un curso en español con
 * términos en inglés se escribe todo en alfabeto latino, así que una palabra con
 * letras y ninguna latina no es una palabra que alguien haya dicho acá.
 *
 * Se mira letra por letra y no por el idioma que informa whisper.cpp, porque el
 * idioma que informa es justamente el que se equivocaría.
 */
function enNuestroAlfabeto(texto) {
    return !/\p{L}/u.test(texto) || /\p{Script=Latin}/u.test(texto);
}

/**
 * Los tramos donde se oye a alguien y Whisper no escribió nada.
 *
 * @param {Array} words palabras del recorte, en segundos del recorte
 * @param {object} mapa mapa de voz del recorte (`engine/voz.js`)
 */
function huecos(words, mapa) {
    const dichas = (words || []).filter(w => String(w.text || '').trim());
    const encontrados = [];

    for (let i = 1; i < dichas.length; i++) {
        const desde = dichas[i - 1].end;
        const hasta = dichas[i].start;
        if (hasta - desde < HUECO_SEC) continue;

        const dentro = mapa.tramos.filter(([a, b]) => b > desde && a < hasta);
        const sonido = dentro.reduce(
            (n, [a, b]) => n + (Math.min(b, hasta) - Math.max(a, desde)), 0);
        if (sonido < HUECO_SEC) continue;

        // Se relee el sonido, no el hueco entero: entre las dos palabras puede
        // haber medio minuto de sala vacía —los huecos del curso duran 29 s y
        // traen 3 s de voz—, y sobre el aire Whisper escribe los créditos de
        // subtítulos que se aprendió de memoria.
        encontrados.push({
            desde,
            hasta,
            leeDesde: Math.max(desde, dentro[0][0] - CONTEXTO_SEC),
            leeHasta: Math.min(hasta, dentro[dentro.length - 1][1] + CONTEXTO_SEC)
        });
    }
    return encontrados;
}

/**
 * Vuelve a leer los huecos con voz y devuelve el transcript con lo que faltaba.
 *
 * **Whisper se come tramos enteros de habla y no avisa.** El caso que lo destapó
 * es una frase en inglés en medio del español: sobre un clip armado a propósito
 * —español, doce segundos de inglés, español— el transcript sale con las dos
 * partes en español y **el inglés no aparece por ningún lado**, ni traducido ni
 * mal escrito: desaparece. Y no es la bandera de idioma: con `-l es`, con `-l
 * auto` y con `-l en` sale exactamente el mismo texto, porque whisper.cpp decide
 * UN idioma por pasada y lo que no encaja lo descarta. Esa misma frase, leída
 * sola, sale entera y correcta.
 *
 * De ahí sale el arreglo, y **lo que lo hace funcionar es la soledad del pedazo,
 * no el idioma que se le pida**: leído solo, sin español alrededor que gane la
 * votación, el inglés sale entero. Tanto que da igual pedirle `es` o `auto` —el
 * texto que devuelve es el mismo—, y por eso se le pide el del curso, que es el
 * que no se va a otro alfabeto cuando el pedazo no se entiende.
 *
 * **La reja es el mapa de voz, y no es opcional.** Sobre ocho segundos de
 * silencio puro whisper.cpp escribe "CC por Antarctica Films Argentina", y sobre
 * ruido de sala, "Gracias por ver el video": créditos de subtítulos aprendidos
 * de memoria, que aparecen igual con el idioma pedido y con `auto`. Si se
 * releyera todo hueco, cada pausa de la clase entraría al guion con uno. Por eso
 * hace falta voz sostenida medida sobre la onda, y por eso se relee el sonido y
 * no el hueco.
 *
 * **Cuánto dispara, medido sobre el curso entero** (`tools/medir-huecos.js`): 12
 * huecos en catorce clases, unas siete horas de audio, un minuto de reloj para
 * todas. No es un camino caliente, y lo que trae es habla real que faltaba: en
 * la clase 2, "piensa en el prompt que utilizaste en la última aplicación" —con
 * "prompt" bien escrito, que la pasada grande deja en "PROM"—; en la clase 4, un
 * "la constitución es la que nos define cómo vamos a trabajar, 3, 2, 1" entero,
 * que es justo la señal con la que esta herramienta abre una toma.
 *
 * **Lo que no arregla.** Los bordes del hueco salen de dónde dice Whisper que
 * empieza la palabra siguiente, y en un tramo mal leído esa palabra se estira
 * hacia atrás para tapar lo que no escribió. Si el cambio de idioma pasa sin una
 * pausa en medio, el borde queda corto y la frase rescatada pierde la cola. Se
 * probó ubicar esa palabra por el DTW, que es lo que `engine/rescate.js` hace en
 * post, y sale mucho peor: sobre el curso pasa de 12 huecos a 71, con relecturas
 * que se pisan entre sí y dejan el guion tartamudeando ("diferencia diferencia
 * diferencia"). Un borde conservador de más pierde palabras; uno de menos
 * duplica el guion, que es mucho más difícil de ver y de deshacer.
 *
 * @returns {Promise<{words:Array, agregadas:number}>}
 */
async function rellenarHuecos(archivo, words, opciones) {
    const o = opciones || {};
    const mapa = voz.deLaClase(archivo);
    // Sin contraste, `deLaClase` no devuelve mapa: o está todo callado o está
    // todo sonando. En los dos casos no hay con qué separar voz de aire, así que
    // no se relee nada.
    if (!mapa) return { words, agregadas: 0 };

    const nuevas = [];
    for (const hueco of huecos(words, mapa)) {
        let leidas = null;
        try {
            leidas = await rescate.leerTramo({
                wavPath: archivo,
                desdeSec: hueco.leeDesde,
                hastaSec: hueco.leeHasta,
                // El mismo idioma que la pasada grande, no `auto`. Lo que
                // recupera la frase en otro idioma es leer el pedazo SOLO, no la
                // bandera: sobre los doce huecos del curso y sobre el clip de
                // prueba, `es` y `auto` devuelven exactamente el mismo texto,
                // inglés incluido. Y `auto` tiene un modo de fallar que `es` no
                // tiene: sobre un tramo donde alguien masculla se va a otro
                // alfabeto —en la clase 8 escribió "뒤에 가려…" donde `es` escribe
                // "Tiene cara…"—, porque un pedazo de siete segundos no le
                // alcanza para detectar nada y elige lo que se le parezca.
                language: o.idioma || 'es',
                // El mismo modelo con el que se leyó el tramo grande. Si esa
                // pasada tuvo que bajar de modelo porque el sistema se la llevaba
                // por delante (`engine/insistir.js`), releer un hueco con el
                // grande sería levantar justo lo que acaba de no caber.
                modelo: o.modelo,
                signal: o.signal
            });
        } catch (err) {
            if (err && err.code === 'cancelado') throw err;
            // Un hueco que no se pudo releer deja la toma como estaba, que es
            // como salía antes de todo esto. No es motivo para perderla.
            continue;
        }

        const dentro = (leidas || []).filter(w => {
            const texto = String(w.text || '').trim();
            return texto && enNuestroAlfabeto(texto)
                && w.start >= hueco.desde && w.start < hueco.hasta;
        });
        nuevas.push(...transcribe.collapseLoops(dentro).words);
    }

    if (!nuevas.length) return { words, agregadas: 0 };
    return {
        words: [...words, ...nuevas].sort((a, b) => a.start - b.start),
        agregadas: nuevas.length
    };
}

/**
 * Palabras de Whisper → palabras con hora del día.
 *
 * `desdeSec` es qué momento del archivo quedó en el segundo 0 del recorte, y
 * `sesion.desdeMs` a qué hora del día empezó ese archivo. Con los dos, el
 * `start` de cada palabra se convierte en una hora, que es el reloj con el que
 * trabaja todo lo demás.
 *
 * Se usa `dtw` cuando viene: es la alineación contra el espectrograma, o sea
 * contra el sonido, y es la que el motor ya eligió para decidir los cortes
 * (`engine/reloj.js`).
 */
function aHoraDelDia(words, sesion, desdeSec) {
    const base = sesion.desdeMs + desdeSec * 1000;
    return (words || []).map(w => {
        const seg = w.dtw != null ? w.dtw : w.start;
        return {
            t: Math.round(base + seg * 1000),
            texto: w.text,
            // El final también, que es lo que deja saber si una palabra se comió
            // un silencio. No se usa para cortar: los cortes van por el arranque.
            hasta: Math.round(base + (w.end != null ? w.end : seg) * 1000)
        };
    });
}

/**
 * Escucha un tramo del reloj de pared y devuelve lo que se dijo.
 *
 * @param {object} params
 *   sesion    la sesión de captura (de `captura.abrir`), con `archivo` y `desdeMs`
 *   desdeMs   hora del día donde empieza lo que hay que oír
 *   hastaMs   hora del día donde termina
 *   liviano   true para el ciclo de señales
 *   idioma    por defecto español, que es el del curso
 *   modelo    con qué leer el tramo grande, si no es el de siempre. Lo usa la
 *             política de reintento cuando el sistema se lleva a whisper-cli y
 *             hay que bajar un escalón (`engine/insistir.js`); sin él manda
 *             `paths.whisperModel`, que es lo que pasa en toda clase que sale bien
 * @returns {Promise<{palabras:Array, colapsadas:number}|null>}
 */
async function escuchar(params) {
    const p = params || {};
    if (!p.sesion) return null;

    const recortado = captura.recorte({
        sesion: p.sesion,
        desdeMs: p.desdeMs,
        hastaMs: p.hastaMs
    });
    if (!recortado) return null;

    try {
        const opciones = { language: p.idioma || 'es' };
        // El liviano, si está. La búsqueda es la misma que muestra Diagnóstico
        // (`paths.modeloLiviano`), así que no pueden discrepar. Si no hay, el
        // ciclo cae al modelo de siempre: peor —un segundo cada tres en vez de un
        // décimo— pero funciona, y no se baja nada solo: bajar un modelo a mitad
        // de una grabación es lo último que uno quiere.
        const liviano = p.liviano ? paths.modeloLiviano() : null;
        if (liviano && liviano.path) opciones.model = liviano;
        // Y el escalón de abajo, cuando la pasada grande ya se murió con el bueno
        // y quien la pide decidió bajar (`engine/oir-toma.js`). Va con la misma
        // regla que el liviano —tiene que venir con ruta— porque caer al de
        // siempre en silencio dejaría a la toma marcada como degradada mintiendo.
        if (!p.liviano && p.modelo && p.modelo.path) opciones.model = p.modelo;

        const salida = await transcribe.runWhisper(recortado.archivo, opciones);

        // Las mismas defensas que en post. Whisper rellena los silencios con
        // repeticiones y con créditos de subtítulos aprendidos de memoria: en el
        // curso escribió "Andrea Oroz Sincronización" cuarenta y cinco veces
        // sobre un tramo donde nadie hablaba. Acá pasa igual, y una toma abierta
        // sobre un silencio es exactamente la situación que lo dispara.
        const limpias = transcribe.collapseLoops(salida.words || []);

        // Y lo que la pasada grande se saltó, que es sobre todo lo que se dijo en
        // otro idioma (`rellenarHuecos`). El ciclo de señales no pasa por acá: son
        // cuatro segundos, su texto se tira y lo único que importa es llegar a
        // tiempo.
        const relleno = p.liviano
            ? { words: limpias.words, agregadas: 0 }
            : await rellenarHuecos(recortado.archivo, limpias.words, {
                idioma: opciones.language, modelo: opciones.model, signal: p.signal
            });

        return {
            palabras: aHoraDelDia(relleno.words, p.sesion, recortado.desdeSec),
            colapsadas: limpias.removed,
            rellenadas: relleno.agregadas
        };
    } finally {
        captura.tirar(recortado);
    }
}

module.exports = {
    aHoraDelDia,
    enNuestroAlfabeto,
    huecos,
    rellenarHuecos,
    escuchar,
    HUECO_SEC
};
