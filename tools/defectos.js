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
 */

const edges = require('../engine/speech-edges');
const repeticiones = require('../engine/repeticiones');
// Reconocer la claqueta lo hace el motor, que la busca en el audio para
// sincronizar: con una copia acá, la medición podía dejar de ver justo la que el
// piso está impidiendo que entre.
const clap = require('../engine/clap-detect');

// La lista de conectores vive en el motor, porque además de medirlos hay que
// quitarlos: `engine/repasar.js` los usa para arreglar el arranque. Con una copia
// acá, la medición podía dejar de ver justo lo que el arreglo estaba quitando.
const CONECTOR_HUERFANO = edges.CONECTOR_HUERFANO;

const TIPOS = ['claqueta', 'chatter', 'conteo', 'colgando', 'conector', 'mitadPalabra', 'repetido'];

/**
 * ¿El corte se metió dentro del sonido?
 *
 * NO se mide contra los tiempos de palabra de Whisper. Whisper entrega las
 * palabras pegadas una a otra —el 99% arranca exactamente donde termina la
 * anterior, y una sola "palabra" puede cubrir ocho segundos de silencio—, así
 * que con ese reloj cualquier corte cae "dentro" de una palabra y la métrica
 * daría 63% siempre, midiendo nada.
 *
 * Lo que sí sabe dónde está el sonido es la medición de onda que el motor ya
 * guardó en cada borde: `airFrames` es el aire entre el corte y el audio. Si es
 * negativo, el corte entró en el sonido.
 */
function entraEnElSonido(edge) {
    const air = edge && edge.audio && edge.audio.airFrames;
    if (typeof air !== 'number') return false;
    // Un frame entero, no una fracción: por debajo de eso no hay nada que
    // arreglar —el corte no puede caer entre dos frames— y lo que se estaría
    // contando es el ruido del detector. Con medio frame salían 28; con uno, 9.
    return air <= -1;
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
        // Huérfano solo si de verdad perdió su antecedente. "Y en cuarto,
        // tenemos…" abre bien cuando el bloque anterior sigue pegado delante:
        // el "en tercero" está ahí y se lee de corrido. Se cuenta cuando entre
        // los dos bloques se tiró material.
        const pegadoAlAnterior = anterior && block.startSec - anterior.endSec < 2;
        if (!pegadoAlAnterior && CONECTOR_HUERFANO.test(edges.textOf(primera))) {
            fallas.push(['conector', `«${dentro.slice(0, 4).map(edges.textOf).join(' ')}…»`]);
        }
    }

    for (const edge of [block.in, block.out]) {
        if (entraEnElSonido(edge)) {
            fallas.push(['mitadPalabra',
                `${edge.kind} en ${edge.timeSec.toFixed(2)}s, ${edge.audio.airFrames.toFixed(1)} frames de aire`]);
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

    return fallas;
}

/** Los defectos de una clase entera, contados por tipo. */
function contarClase(words, blocks) {
    const cuenta = Object.fromEntries(TIPOS.map(t => [t, 0]));
    const ejemplos = [];
    let anterior = null;
    let total = 0;

    // Solo lo que sale en la clase. Un bloque apagado —una arrancada en falso que
    // se descartó— sigue en el plan con su marca, pero medir sus defectos es
    // contar como problema justo lo que ya se resolvió sacándolo.
    for (const block of (blocks || []).filter(b => b.enabled !== false)) {
        total++;
        for (const [tipo, texto] of revisarBloque(words, block, anterior)) {
            cuenta[tipo]++;
            ejemplos.push({ bloque: block.index + 1, tipo, texto });
        }
        anterior = block;
    }
    return { cuenta, ejemplos, total };
}

module.exports = { revisarBloque, contarClase, entraEnElSonido, TIPOS, CONECTOR_HUERFANO };
