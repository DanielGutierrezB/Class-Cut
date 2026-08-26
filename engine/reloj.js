'use strict';
/**
 * reloj.js — Cuándo se dijo cada palabra.
 *
 * El transcript sabe QUÉ se dijo y en qué orden, y eso no se toca nunca. El cuándo
 * es otra historia: whisper.cpp corre con una palabra por segmento y los segmentos
 * se pegan uno al otro, así que el "final" de una palabra es el arranque de la
 * siguiente y nadie midió dónde para el sonido. En el curso hay 3.735 palabras de
 * 45.182 durando cero y una cuenta de "3, 2, 1." que dura 1,4 s figurando ocupando
 * 8,7.
 *
 * Hay tres alineaciones para arreglarlo y cada una sabe una cosa distinta:
 *
 *   - **La onda** (`audio-onset.alignWords`) mide los dos bordes de cada tirada
 *     contra el WAV. Ahí es la mejor que hay —20 ms de error— y adentro de la
 *     tirada no mide nada: reparte proporcionalmente lo que dijo el STT.
 *   - **El DTW** de whisper.cpp alinea cada palabra contra el espectrograma.
 *     Adentro de la frase parte al medio el error de la onda; en el borde de la
 *     tirada es peor que ella (60 ms contra 20).
 *   - **El reparto sobre el mapa de voz** (`retimeo.js`) rehace las tiradas que
 *     Whisper puso encima de un silencio. Es el camino de los transcripts sin DTW.
 *
 * De acá sale la combinación: `deDtw` injerta la onda y el DTW, cada uno donde es
 * bueno. Y de este reloj vive todo —el panel del visor y los cortes—, así que vive
 * en su propio módulo y no en el del visor, que es donde nació.
 *
 * **Que con este se corte mejor está medido, no supuesto.** Las trece clases
 * transcriptas de nuevo, entradas congeladas, mismo criterio y misma semilla, lo
 * único distinto el reloj (`tools/medir-repaso.js --reloj`). Los totales que
 * siguen son de antes de arreglar el conector huérfano, así que no se comparan
 * con una corrida de hoy; el orden entre los relojes no cambia. (De paso: el
 * renglón del conector es el único que había SUBIDO al cablear este reloj, 7 → 12,
 * y no era del reloj sino de la vara. Sobre los mismos cortes, el crudo veía 9 y
 * este ve 12, porque con los tiempos viejos la cola del conteo caía adentro del
 * bloque y tapaba la primera palabra. Con la pregunta correcta son 0 y este reloj
 * no empeoró nada — `speech-edges.conectorSinPedir`.) Cada plan medido con el
 * reloj con el que se decidió, que es la única lectura coherente de un plan: 24
 * defectos de borde con el crudo, 26 con el reparto sobre la onda, 21 con este. Y
 * los cortes que caen encima de alguien hablando —la única vara que no depende del
 * reloj con el que se mire, porque la contesta la onda al colocar el borde— 4, 6 y
 * 1. Después, sobre el curso rehecho: los defectos de borde van de 29 a 18, y el
 * corte renderizado y vuelto a transcribir (`tools/verificar-corte.js`) pasa de 15 a
 * 6 conteos de toma oídos y de 26 a 19 palabras de más.
 *
 * Sin estado, sin audio y sin archivos: entran palabras con tiempos y salen
 * palabras con tiempos (`tests/reloj.test.js`).
 */

const retimeo = require('./retimeo');

/**
 * Cuánto se le resta al instante del DTW para que caiga donde arranca el sonido.
 *
 * Que hay que restar algo, y de qué orden, lo dice el ataque que
 * `audio-onset.alignWords` midió en la onda: el DTW cae una mediana de 105 ms más
 * tarde en la clase 1 (303 tiradas) y de 120 ms en la clase 9.
 *
 * **Cuánto exactamente no se puede resolver más fino que "algo entre 120 y 140
 * ms", y conviene saberlo para no andar afinándolo.** Barrido ADENTRO de las
 * tiradas, que es donde el desfase se aplica, con dos varas que se quejan de lados
 * opuestos:
 *
 *   - Los tramos de sonido de +0,5 s donde no arranca ninguna palabra: 46 defectos
 *     de 1.042 con −0 ms, 49 con −120, 51 con −140 y ya 56 con −160. O sea que es
 *     plana hasta 140 —media décima de punto contra los 2,7 puntos que separan a
 *     las dos clases entre sí— y de 160 para arriba se cae.
 *   - Emparejando cada tramo de sonido con la palabra interior más cercana y
 *     mirando cuánto se separan: las que caen a menos de 100 ms del arranque del
 *     sonido son 46% con −80 ms, 54% con −100, 58% con −120, 60% con −140 y 60%
 *     con −160, y el error mediano se queda clavado en 80 ms para todo −120…−180.
 *     Esta se cae por abajo.
 *
 * Entre las dos, la banda que ninguna castiga es 120–140, y adentro de esa banda
 * no hay señal: los 4 puntos que se mueve la segunda vara son los mismos que se
 * mueve cambiando de qué reloj sale el emparejamiento. 140 queda.
 *
 * Y una trampa, para no volver a caer: emparejar el tramo con "la primera palabra
 * que arranca adentro" en vez de con la más cercana censura el resultado, porque
 * al restar más la palabra se va antes del tramo y la reemplaza la siguiente. Esa
 * versión contesta siempre "restá 80 ms más que el ancla que usaste" —con ancla en
 * 140 pide 240, con ancla en 60 pide 140— y eso es una respuesta sobre el ancla,
 * no sobre el audio.
 */
const DESFASE_DTW_SEC = 0.14;

/**
 * La resolución con la que el DTW dice las cosas, que es también lo mínimo que se
 * separan dos palabras seguidas.
 *
 * whisper.cpp devuelve el instante en centésimas de segundo, así que dos palabras
 * con el mismo número no son simultáneas: son dos que su grilla no pudo separar.
 * Y dejarlas empatadas no es neutral — `letra.palabraEn` alumbra la ÚLTIMA que
 * arrancó, así que de un empate la primera no se alumbra nunca, y una palabra que
 * no se alumbra nunca es texto que el editor no puede seguir. En la clase 1 son
 * 53 de 4.296. Separarlas por la resolución de la medida no invita nada: dice lo
 * que la medida dice, en orden.
 */
const RESOLUCION_DTW_SEC = 0.01;

function redondo(n) {
    return Math.round(n * 1000) / 1000;
}

/**
 * El reloj armado sobre la alineación por DTW, que es el mejor que hay.
 *
 * **La regla: la onda manda donde la onda midió, el DTW manda en todo lo demás.**
 * Los dos alineadores son buenos en lugares distintos y está medido: donde
 * `audio-onset.alignWords` engancha —el arranque de cada tirada, que es donde hay
 * silencio a un lado y puede medir un ataque limpio— el DTW puro EMPEORA el borde,
 * 60 ms de error contra los 20 ms de hoy. Adentro de la tirada `alignWords` no
 * mide nada (reparte proporcionalmente lo que el STT dijo) y ahí el DTW parte el
 * error al medio. Así que se injerta: la primera palabra de cada tirada se queda
 * con el arranque de la onda, las de adentro van por DTW. Injertado, el borde
 * empata exacto con lo de hoy y todo lo demás mejora.
 *
 * **Y "donde la onda midió" es una pregunta que hay que hacer, no dar por
 * sentada.** La primera versión de esta regla decía "la primera palabra de cada
 * tirada" y nada más, y eso le devolvía el arranque a la onda TAMBIÉN en las
 * tiradas donde la onda no había medido nada. Cuando el que habla está lejos del
 * micrófono `alignWords` no encuentra ataque y deja el tiempo crudo de Whisper, y
 * el injerto lo prefería por sobre un DTW que tenía razón. Son 628 de las 3.157
 * tiradas del curso (19,9%) y siempre las mismas palabras: las órdenes del director
 * —`Ok.`, `Sí,`, `3,`, `Listo.`, `Claqueta`—, justo lo que el recorte de muletillas
 * necesita poder leer.
 *
 * La señal no hubo que inventarla ni hubo que ponerle un umbral de discrepancia:
 * `alignWords` sabe perfectamente en qué tramos midió un ataque y en cuáles pasó
 * de largo, solo que no lo decía. Ahora lo deja anotado por palabra (`onset`) y el
 * injerto lo lee. Un transcript que no traiga la marca —una clase sin Live-Mix, o
 * uno de los primeros con DTW— se lee como "nadie midió" y va todo por DTW, que
 * es lo único honesto que se puede hacer con un arranque que nadie miró.
 *
 * **El caso que lo puso a prueba** es el arranque de la clase 1, el pasaje más
 * difícil que hay: el director dice "Cuando estés listo, por favor, dame el
 * claqueta 1" desde 8,56 s —la envolvente pasa de 0,00025 a 0,00082 justo ahí y se
 * sostiene un segundo—, el DTW pone esas palabras en 8,62-10,80 y Whisper le había
 * puesto a "Cuando" un 0,65 s. La onda no mide nada ahí, así que no hay marca, así
 * que manda el DTW: la palabra se alumbra a 80 ms de donde suena en vez de a ocho
 * segundos.
 *
 * **Por qué no pasa por `retimeo`.** Correrlo encima de esto lleva esos mismos
 * bordes buenos de 20 a 213 ms, y el motivo no es un parámetro mal puesto:
 * `retimeo.esRota` pregunta "¿hay sonido en el mapa adentro de esta palabra?", y
 * sobre tiempos que ya salen del sonido un "no" dejó de significar "Whisper le
 * colgó un silencio" para significar "el micrófono no registró el habla". En la
 * clase 1 el mapa de voz arranca en 15,5 s mientras el director venía hablando
 * desde 8,5 s: son 6.976 palabras, el 15,5% del curso, que `retimeo` declararía
 * rotas y saldría a repartir sobre un sonido que no está donde se dijo. `retimeo`
 * queda igual y sigue siendo el camino de los transcripts sin DTW.
 *
 * **Los finales son los del transcript, y eso no es pereza: es lo único honesto.**
 * El DTW da un instante por palabra y nada más. La primera versión de esto cerraba
 * cada palabra donde arrancaba la siguiente, y al panel no le molestaba —
 * `letra.palabraEn` alumbra la última que arrancó y no mira duraciones— pero
 * convertía el "final" de una palabra en el ARRANQUE de otra, que es un número que
 * significa algo muy distinto. Se vio al darle este reloj al motor:
 * `speech-edges.wordLimits` saca el piso del IN del final de la palabra anterior, y
 * con ese final pegado al arranque del sonido el colchón de aire no tiene dónde
 * caber y el corte queda encima de la voz. Seis bloques del curso, todos por lo
 * mismo — en el 7 de la clase 6 el piso quedaba en 1469,24 con el sonido arrancando
 * en 1469,20, y con el final del transcript queda en 1468,73 y el colchón entra.
 *
 * Así que cada alineación aporta lo que sabe, y las dos cosas están medidas en este
 * proyecto: el DTW sabe ARRANQUES (adentro de la frase parte al medio el error de
 * la onda) y no sabe finales; Whisper acierta los FINALES de palabra (sesgo mediano
 * de 0 frames) y adelanta los arranques sobre el silencio que los precede. El final
 * que queda es el del transcript, acotado para que no se cruce con el arranque de
 * la palabra que sigue — que es un techo, no una medición.
 *
 * @param {Array} palabras [{start, end, text, dtw?, onset?}] con los tiempos del Backup
 * @returns {{palabras: Array, stats: object}}
 */
function deDtw(palabras) {
    const entrada = palabras || [];
    const salida = entrada.map(p => ({ ...p }));
    const stats = { tiradas: 0, injertadas: 0, deLaOnda: 0, sinOnda: 0, sinDtw: 0, aplastadas: 0 };

    // Dónde cerró la tirada anterior. Hace falta como piso de la que viene cuando
    // su arranque sale del DTW: el arranque de la onda no puede caer antes que la
    // tirada de antes —lo midió con ella al lado— pero el del DTW sí, y una
    // palabra que arranca antes que la anterior el panel no la alumbra nunca.
    let cerroLaPrevia = -Infinity;

    // Las tiradas son las de `retimeo`, con el mismo hueco, y eso no es
    // comodidad: son las MISMAS que arma `alignWords` con su `alignMinGapSec`.
    // Si se cortaran en otro lado, la marca de la onda estaría puesta en una
    // palabra que acá no abre ninguna tirada y nadie la leería.
    for (const tirada of retimeo.tiradas(entrada, retimeo.HUECO_SEC)) {
        stats.tiradas++;
        const cierre = entrada[tirada[tirada.length - 1]].end;
        const abre = entrada[tirada[0]];
        // Acá está todo el injerto: si la onda midió el ataque de esta tirada, ese
        // arranque es el mejor que hay y se conserva; si no lo midió, el `start`
        // que trae la palabra es el crudo del STT —el que llega a estar ocho
        // segundos antes de que se oiga nada— y el DTW tiene más para decir.
        const deLaOnda = abre.onset === true;
        if (deLaOnda) stats.deLaOnda++; else stats.sinOnda++;
        let previo = deLaOnda ? abre.start : cerroLaPrevia;

        for (let k = 0; k < tirada.length; k++) {
            const original = entrada[tirada[k]];
            let arranca = original.start;
            if (k > 0 || !deLaOnda) {
                if (original.dtw == null) stats.sinDtw++;
                else { arranca = original.dtw - DESFASE_DTW_SEC; stats.injertadas++; }
            }
            // Nunca antes de la palabra anterior ni después del final de la
            // tirada. Son dos medidas distintas del mismo sonido y en el empalme
            // se cruzan; una palabra que arranca antes que la anterior el panel
            // no la alumbra nunca, porque busca la última que ya arrancó.
            const piso = (k === 0 && deLaOnda) ? previo : previo + RESOLUCION_DTW_SEC;
            const acotado = Math.min(Math.max(arranca, piso), cierre);
            if (acotado !== arranca) stats.aplastadas++;
            salida[tirada[k]].start = redondo(acotado);
            previo = salida[tirada[k]].start;
        }

        // Los finales, del transcript: el DTW no tiene ninguno. Con el techo del
        // arranque de la que sigue —que no es una medición, es el orden— y sin
        // dejar ninguna durando cero: el DTW puede haber corrido el arranque más
        // allá del final que la palabra traía. La resolución del DTW alcanza como
        // mínimo y no aprieta el techo, porque dos arranques seguidos ya están
        // separados por eso mismo.
        for (let k = 0; k < tirada.length; k++) {
            const palabra = salida[tirada[k]];
            const techo = k + 1 < tirada.length ? salida[tirada[k + 1]].start : cierre;
            palabra.end = redondo(Math.max(
                Math.min(entrada[tirada[k]].end, techo),
                palabra.start + RESOLUCION_DTW_SEC));
        }
        cerroLaPrevia = salida[tirada[tirada.length - 1]].end;
    }

    return { palabras: salida, stats };
}

/**
 * ¿Este transcript trae la alineación por DTW?
 *
 * La pregunta es por PALABRA y no por versión del transcript: un transcript de la
 * versión 5 hecho con un modelo del que no se conoce la grilla de cabezas de
 * atención tampoco la trae, y tiene que abrir por el mismo camino que uno de la 4.
 */
function traeDtw(palabras) {
    return (palabras || []).some(p => p.dtw != null);
}

/**
 * Los tiempos con los que se deciden los cortes.
 *
 * Vive acá y no en cada caller porque el reloj es parte de decidir, no de leer
 * archivos: si `tools/bench-models.js` midiera con otro reloj que la app, estaría
 * midiendo un producto que no se distribuye. `como` existe para el A/B de
 * `tools/medir-repaso.js`, que necesita poder pedir el reloj crudo a propósito.
 *
 * @param {Array} palabras
 * @param {string} como `auto` (el DTW si el transcript lo trae) | `crudo`
 */
function paraDecidir(palabras, como) {
    if (como === 'crudo' || !traeDtw(palabras)) {
        return { palabras: palabras || [], como: 'crudo', stats: null };
    }
    const armado = deDtw(palabras);
    return { palabras: armado.palabras, como: 'dtw', stats: armado.stats };
}

module.exports = {
    deDtw, traeDtw, paraDecidir, DESFASE_DTW_SEC, RESOLUCION_DTW_SEC
};
