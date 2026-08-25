'use strict';
/**
 * pista.js — La clase ya cortada, vista como una sola línea de tiempo.
 *
 * El plan de cortes son tramos del material original, cada uno con su cámara.
 * Reproducir "la clase cortada" es recorrer esos tramos uno detrás de otro como
 * si fueran continuos, y para eso hace falta traducir en las dos direcciones:
 * de un segundo del resultado final al segundo del archivo que hay que mostrar,
 * y al revés para dibujar dónde está la aguja.
 *
 * Se recalcula desde los bloques que el editor tiene en pantalla y no desde las
 * posiciones que trae el plan del disco: así, mover un borde o sacar un bloque
 * se ve en el reproductor antes de guardar, que es justamente cuando sirve.
 *
 * Sin estado y sin DOM: esto se prueba solo (`tests/pista.test.js`).
 */

/**
 * Cuántos colores de cámara hay definidos en la hoja de estilo (`.cam-0` a
 * `.cam-7`, en el mismo orden que `CLIP_LABELS` de `engine/fcp-xml.js`). Vive
 * acá, con el índice al que acompaña, porque lo usan tanto la tira del
 * reproductor como el panel de texto.
 */
export const COLORES_DE_CAMARA = 8;

/**
 * Con qué cámara se ve un bloque.
 *
 * Se resuelve desde la vista y no desde el `cameraIndex` que trae el plan,
 * porque ese número lo recalcula el exportador recién al guardar: cambiar un
 * bloque de PV a R y mirarlo enseguida mostraría la cámara anterior, que es
 * justo lo contrario de para qué sirve poder verlo antes de guardar.
 */
function camaraDe(segment, viewMap, camaras) {
    let indice = viewMap ? viewMap[segment.view] : null;
    if (indice == null) indice = segment.cameraIndex;
    if (indice == null) indice = 0;
    // Una vista que apunta a una cámara que esta clase no tiene va con la
    // primera, igual que hace el plan de cortes, en vez de quedar sin imagen.
    if (camaras && indice >= camaras) indice = 0;
    return indice;
}

/**
 * La cámara que va en el recuadro, encima de la principal.
 *
 * Cuando el bloque va con el screen recorder, ver solo la pantalla deja al
 * profesor fuera de cuadro. La que se le pone encima es siempre la del profesor
 * —la que la clase mapea a la vista `PV`—, y solo cuando el bloque no la está
 * usando ya como imagen principal.
 *
 * @returns {number|null} índice de cámara, o null si este bloque no lleva recuadro
 */
function insetDe(principal, viewMap, camaras, vistaDelProfesor) {
    if (!vistaDelProfesor) return null;
    let indice = viewMap ? viewMap[vistaDelProfesor] : 0;
    if (indice == null) indice = 0;
    // Una clase grabada con una sola cámara no tiene con qué armar el recuadro.
    if (camaras && indice >= camaras) return null;
    return indice === principal ? null : indice;
}

/**
 * @param {Array} segments bloques del plan, en orden
 * @param {object} [opciones] { viewMap, camaras, vistaDelProfesor, notas }
 *   `notas` es el mapa de notas corregidas (`rev.notas.bloques`): la nota
 *   efectiva se resuelve acá, UNA vez, y todo lo que dibuja —el overlay del
 *   reproductor, la tira, el panel de texto— lee la misma. Cuando cada vista la
 *   resolvía por su cuenta, el panel mostraba la corregida y el reproductor la
 *   vieja del marcador.
 * @returns {{tramos:Array, duracionSec:number}}
 */
export function construir(segments, opciones) {
    const { viewMap, camaras, vistaDelProfesor, notas } = opciones || {};
    const tramos = [];
    let acumulado = 0;

    for (const segment of segments || []) {
        if (segment.keep === false) continue;
        const desde = Number(segment.sourceStartSec);
        const hasta = Number(segment.sourceEndSec);
        // Un bloque invertido o de duración cero no se puede reproducir, y
        // dejarlo pasar rompe el mapeo de todo lo que viene después.
        if (!isFinite(desde) || !isFinite(hasta) || hasta <= desde) continue;

        const dura = hasta - desde;
        const camara = camaraDe(segment, viewMap, camaras);
        // La nota del marcador, y nada más. Antes se caía al `cueIn`, que no es
        // una nota: es el arranque del transcript que el Rodecaster guarda detrás
        // del guion del comentario. El campo mostraba un pedazo de letra cortado
        // a media palabra como si alguien lo hubiera escrito. Si no hay nota, no
        // hay: el panel ya tiene su texto para el campo vacío.
        const notaOriginal = segment.note || '';
        const corregida = notas && notas[segment.blockIndex] && notas[segment.blockIndex].note;
        tramos.push({
            indice: tramos.length,
            blockIndex: segment.blockIndex,
            desdeSec: acumulado,
            hastaSec: acumulado + dura,
            duracionSec: dura,
            origenDesdeSec: desde,
            origenHastaSec: hasta,
            camara,
            inset: insetDe(camara, viewMap, camaras, vistaDelProfesor),
            view: segment.view || '',
            nota: corregida || notaOriginal,
            // La del marcador se conserva aparte: el panel la necesita para
            // saber si la efectiva está corregida y para poder volver a ella.
            notaOriginal,
            confidence: segment.confidence || 'baja'
        });
        acumulado += dura;
    }

    return { tramos, duracionSec: acumulado };
}

/**
 * Los comentarios que caen dentro de un tramo de la grabación.
 *
 * Se miden contra el tramo completo y no contra sus palabras: un comentario
 * puesto donde nadie habla igual pertenece al bloque, y buscándolo solo entre
 * las palabras quedaría anclado a algo invisible e imposible de volver a tocar.
 *
 * @param {number} desdeSec en tiempo de la grabación
 * @param {number} hastaSec
 * @param {Array} comentarios los de `notas.json`, anclados al tiempo de grabación
 */
export function comentariosEn(desdeSec, hastaSec, comentarios) {
    if (!comentarios) return [];
    return comentarios
        .filter(c => c.sourceStartSec >= desdeSec && c.sourceStartSec <= hastaSec)
        .sort((a, b) => a.sourceStartSec - b.sourceStartSec);
}

/**
 * En qué tramo cae un momento del corte final, y a qué segundo del archivo.
 *
 * @returns {{tramo:object, origenSec:number}|null}
 */
export function tramoEn(pista, segundo) {
    const tramos = (pista && pista.tramos) || [];
    if (!tramos.length) return null;

    const t = Math.max(0, Math.min(segundo, pista.duracionSec));
    // El último tramo llega hasta el final inclusive; los demás terminan donde
    // empieza el siguiente, para que un borde exacto no caiga en dos lados.
    const tramo = tramos.find(x => t < x.hastaSec) || tramos[tramos.length - 1];
    return {
        tramo,
        origenSec: tramo.origenDesdeSec + Math.max(0, t - tramo.desdeSec)
    };
}

/** El momento del corte final en el que empieza un bloque del plan. */
export function posicionDeBloque(pista, blockIndex) {
    const tramo = ((pista && pista.tramos) || []).find(x => x.blockIndex === blockIndex);
    return tramo ? tramo.desdeSec : null;
}

/**
 * Dado un tramo y el segundo de origen que va corriendo, ¿ya se pasó del final?
 *
 * Se pregunta contra el archivo y no contra el reloj del corte final porque el
 * `<video>` avanza por su cuenta entre pedido y pedido: lo único que se sabe de
 * cierto es en qué segundo del archivo está.
 */
export function seTermino(tramo, origenSec) {
    return !tramo || origenSec >= tramo.origenHastaSec;
}

/** El tramo que sigue, o null si ese era el último. */
export function siguiente(pista, tramo) {
    const tramos = (pista && pista.tramos) || [];
    if (!tramo) return tramos[0] || null;
    return tramos[tramo.indice + 1] || null;
}
