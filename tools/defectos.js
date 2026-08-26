'use strict';
/**
 * defectos.js — Qué tiene de malo un bloque cortado.
 *
 * Es la definición de "corte malo" del proyecto, y vive en un solo lugar a
 * propósito: la usan `medir-cortes.js`, que mide el curso ya procesado, y
 * `medir-repaso.js`, que reprocesa en memoria. Con una copia en cada uno, un
 * banco podía decir que una variante mejora mientras la medición oficial decía
 * lo contrario, y las dos tenían razón.
 *
 * Nada de acá le pregunta a ningún modelo: son reglas sobre el texto y sobre la
 * medición de onda que el motor ya guardó en cada borde.
 *
 * **Lo que esta vara todavía no ve**, y conviene saberlo antes de usar el total
 * para decidir algo: un bloque que abre sobre una toma abortada y arrastra
 * silencio no dispara nada. El bloque 4 de la clase 2 decidido con el reloj
 * crudo abre en 770,7 —28 s antes del marcador del CD—, se lleva adentro
 * «¿Recuerdas en la clase anterior que cuando hicimos una modificación,» de un
 * intento que el profesor rehizo, y de sus primeros treinta segundos solo suenan
 * nueve. Cero defectos. `retoma` no lo agarra porque entre las dos tomas no hay
 * conteo, y ninguna regla mira cuánto silencio quedó adentro.
 */

const edges = require('../engine/speech-edges');
const repeticiones = require('../engine/repeticiones');
const retoma = require('../engine/retoma');
// Reconocer la claqueta lo hace el motor, que la busca en el audio para
// sincronizar: con una copia acá, la medición podía dejar de ver justo la que el
// piso está impidiendo que entre.
const clap = require('../engine/clap-detect');

const TIPOS = ['claqueta', 'chatter', 'conteo', 'colgando', 'abriendo', 'conector',
    'mitadPalabra', 'repetido', 'retoma'];

/**
 * ¿El corte se metió dentro del sonido?
 *
 * NO se mide contra los tiempos de palabra de Whisper. Whisper entrega las
 * palabras pegadas una a otra —el 99% arranca exactamente donde termina la
 * anterior, y una sola "palabra" puede cubrir ocho segundos de silencio—, así
 * que con ese reloj cualquier corte cae "dentro" de una palabra y la métrica
 * daría 63% siempre, midiendo nada.
 *
 * Y tampoco se mide con `airFrames`, que es lo que hacía esto antes y era una
 * lectura equivocada de un número bien calculado. `airFrames` mide contra el
 * tiempo que traía el TRANSCRIPT, y el corte que se aplica es otro: `evaluate`
 * le resta el colchón al borde del sonido, así que el corte sale siempre del
 * lado del silencio. Un `airFrames` negativo dice "la propuesta del transcript
 * caía adentro del sonido y la onda la corrigió" — que es una medida de lo mal
 * que estaba el transcript, no de cómo quedó el corte. En los dos bordes del
 * curso que figuraban en negativo (clase 4 bloque 5 con -4,0 y clase 6 bloque 2
 * con -1,2), el corte aplicado tenía 5,4 y 7,8 frames de aire.
 *
 * Confundir las dos cosas no era gratis: con `airFrames`, decidir los cortes
 * sobre los tiempos corregidos contra la onda pasaba de 3 defectos de este tipo
 * a 8, y ese salto fue el que dejó el re-timeo fuera del motor. Contado como se
 * cuenta acá ahora, la misma comparación va de 3 a 1: el reparto MEJORA justo el
 * defecto por el que se lo había descartado. Es lo que tenía que pasar — la
 * métrica vieja medía cuánto se equivocaba el transcript, y el reparto está para
 * eso.
 *
 * Lo que se mira es lo que oye el editor: en el frame donde cae el corte, ¿hay
 * alguien hablando? Lo contesta el motor al colocar el borde, con el mismo
 * umbral con el que lo eligió (`audio-onset.insideVoice`).
 */
function entraEnElSonido(edge) {
    const audio = edge && edge.audio;
    return Boolean(audio && audio.dentroDelSonido === true);
}

/**
 * ¿Este borde trae la medición con la que se cuenta "mitad de palabra"?
 *
 * Se cuenta aparte porque un plan viejo —o uno de una clase sin Live-Mix— no la
 * trae, y sin decirlo un cero se lee como "no hay cortes a mitad de palabra"
 * cuando lo que pasa es que nadie miró. Es el mismo cuidado que con las clases
 * cuya lectura del guion se cayó.
 */
function midioElSonido(edge) {
    const audio = edge && edge.audio;
    return Boolean(audio && typeof audio.dentroDelSonido === 'boolean');
}

/**
 * Lo que está mal en un bloque.
 *
 * @param {Array} words palabras del transcript de la clase
 * @param {object} block bloque del alineado
 * @param {object|null} anterior el bloque de antes, para ver repeticiones
 * @returns {Array<[string,string]>} pares [tipo, explicación]
 */
function revisarBloque(words, block, anterior) {
    const dentro = edges.wordsInside(words, block.startSec, block.endSec);
    const fallas = [];

    if (dentro.length) {
        const ultima = dentro[dentro.length - 1];
        const primera = dentro[0];

        // La claqueta dentro del corte. Es el peor defecto posible y hasta ahora
        // no se medía: la clase 6 del curso empezaba con "Claqueta 6, clase 6.
        // 3, 2, 1. Ya…" y ninguna cuenta lo veía, porque "Claqueta" no es una
        // palabra de charla ni un conteo — es su propia categoría.
        const claqueta = dentro.findIndex(w => clap.looksLikeClaqueta(edges.textOf(w)));
        if (claqueta >= 0) {
            fallas.push(['claqueta',
                `dentro: «${dentro.slice(claqueta, claqueta + 4).map(edges.textOf).join(' ')}…»`]);
        }

        if (edges.isChatter(ultima, 0, null, dentro[dentro.length - 2])) {
            fallas.push(['chatter', `cierra en «${edges.textOf(ultima)}»`]);
        } else if (edges.isChatter(primera, 0, null, dentro[1])) {
            fallas.push(['chatter', `abre en «${edges.textOf(primera)}»`]);
        }

        // El conteo de la toma dentro del bloque. Se cuenta aparte del chatter
        // porque es el peor de todos: "Ok. 3, 2, 1. En este curso…" no es una
        // palabra de más, es la claqueta hablada metida en la clase, y el editor
        // la tiene que sacar a mano en cada bloque donde aparezca.
        const conteo = edges.finDeConteo(dentro);
        if (conteo >= 0) {
            fallas.push(['conteo', `abre con «${dentro.slice(0, conteo + 2).map(edges.textOf).join(' ')}…»`]);
        }
        if (!edges.endsSentence(ultima)) {
            fallas.push(['colgando', `…${dentro.slice(-4).map(edges.textOf).join(' ')}`]);
        }
        // Y que tampoco ABRA partiendo una frase, que es el mismo defecto del
        // otro lado del bloque y era el punto ciego de esta vara: sin esta línea,
        // correr un IN detrás del conector con el que abría mejoraba el total de
        // 18 a 7 dejando once bloques abriendo en «la sexta herramienta no es…».
        // El criterio, con los números, está en `speech-edges.abreAMitad`.
        if (edges.abreAMitad(words, block.startSec, block.endSec)) {
            fallas.push(['abriendo', `${dentro.slice(0, 4).map(edges.textOf).join(' ')}…`]);
        }
        // Huérfano solo si el CD no abrió el bloque así. El criterio y los
        // números están en `speech-edges.conectorSinPedir`.
        //
        // Acá vivía otra pregunta —"¿se tiró material entre los dos bloques?",
        // contestada con el hueco hasta el anterior— y estaba midiendo el
        // material grabado en vez de la clase: `cutplan.js` pega los bloques que
        // sobreviven uno tras otro, así que el anterior suena siempre justo
        // antes. Sobre el curso con la alineación acústica informaba 12 bloques
        // "arrancando con un conector huérfano" y los 12 los había escrito así el
        // director; con la pregunta correcta son 0. El renglón subía de 7 a 12
        // por lo mismo que bajaban los otros: sobre los mismos cortes, el reloj
        // crudo veía 9 y el del DTW ve 12, porque con los tiempos viejos la cola
        // del conteo caía adentro del bloque y la primera palabra que esta cuenta
        // miraba era el "1." y no el conector. Los tres que aparecían no eran
        // cortes nuevos: eran los mismos cortes, contados sin el conteo encima.
        if (edges.conectorSinPedir(primera, block.cueIn)) {
            fallas.push(['conector', `«${dentro.slice(0, 4).map(edges.textOf).join(' ')}…»`]);
        }
    }

    for (const edge of [block.in, block.out]) {
        if (entraEnElSonido(edge)) {
            fallas.push(['mitadPalabra',
                `${edge.kind} en ${edge.timeSec.toFixed(2)}s, encima de alguien hablando`]);
        }
    }

    // Repetición: el bloque anterior ya dijo lo que este va a decir.
    //
    // Se mide con el mismo detector que la usa para arreglarla, y no con la
    // comparación literal que había acá antes. Esa comparación daba CERO sobre
    // las trece clases del curso mientras el detector encontraba quince, porque
    // dos tomas de una frase no comparten las palabras: "y es justamente ese el
    // problema por el que ByCoin no escala" contra "y justo ese es el problema
    // por el que el Bitcoin no escala". Una métrica que no ve el defecto que se
    // está arreglando no sirve para decidir si el arreglo sirvió.
    if (anterior) {
        const solape = repeticiones.solapeEntre(words, anterior, block, {});
        if (solape) {
            const cabeza = dentro.slice(0, 5).map(edges.textOf).join(' ');
            fallas.push(['repetido', `el anterior ya decía «${cabeza}…»`]);
        }
    }

    // Retoma: las dos tomas de lo mismo quedaron DENTRO de este bloque.
    //
    // Es la otra mitad del defecto de arriba y hacía falta contarla aparte,
    // porque la de arriba mira el bloque anterior y por eso no puede ver nada
    // cuando el CD marcó el IN antes del primer intento y el OUT después del
    // segundo. Sin esta línea, el bloque 3 de la clase 1 —41,2 s con la misma
    // explicación dos veces— medía cero defectos, y una vara que no ve el
    // defecto no sirve para decidir si el arreglo sirvió.
    const dentroDelBloque = retoma.buscarEnBloque(words, block, {});
    if (dentroDelBloque) {
        fallas.push(['retoma',
            `${dentroDelBloque.seVaSec}s de más: la toma se rehace tras la cuenta de ` +
            `${dentroDelBloque.cuentaSec}s`]);
    }

    return fallas;
}

/** Los defectos de una clase entera, contados por tipo. */
function contarClase(words, blocks) {
    const cuenta = Object.fromEntries(TIPOS.map(t => [t, 0]));
    const ejemplos = [];
    let anterior = null;
    let total = 0;
    let sinMedir = 0;

    // Solo lo que sale en la clase. Un bloque apagado —una arrancada en falso que
    // se descartó— sigue en el plan con su marca, pero medir sus defectos es
    // contar como problema justo lo que ya se resolvió sacándolo.
    for (const block of (blocks || []).filter(b => b.enabled !== false)) {
        total++;
        for (const edge of [block.in, block.out]) {
            if (edge && !midioElSonido(edge)) sinMedir++;
        }
        for (const [tipo, texto] of revisarBloque(words, block, anterior)) {
            cuenta[tipo]++;
            ejemplos.push({ bloque: block.index + 1, tipo, texto });
        }
        anterior = block;
    }
    return { cuenta, ejemplos, total, sinMedir };
}

module.exports = {
    revisarBloque, contarClase, entraEnElSonido, midioElSonido, TIPOS
};
