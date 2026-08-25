'use strict';
/**
 * letra.js — El transcript repartido en los bloques del corte, para leerlo
 * mientras suena.
 *
 * Whisper devuelve las palabras de la clase entera, en tiempo de la grabación.
 * El panel las necesita al revés: agrupadas por bloque y en tiempo del corte
 * montado, que es lo que avanza la aguja. Traducir es sumar el desplazamiento
 * del tramo, y descartar lo que quedó afuera.
 *
 * Un detalle que no es obvio: Whisper devuelve palabras que **se pisan** entre
 * sí, y hasta alguna que empieza antes de terminar la anterior. Por eso "qué
 * palabra suena ahora" se resuelve buscando la última que ya arrancó y no la que
 * contiene el segundo: con solapamientos, lo segundo prende dos a la vez o
 * ninguna.
 *
 * Sin estado y sin DOM: esto se prueba solo (`tests/letra.test.js`).
 */

/**
 * Las pausas de un bloque, en tiempo del corte y ubicadas en el texto.
 *
 * `trasPalabra` es el índice de la última palabra que arrancó antes del
 * silencio, que es donde el panel dibuja el aviso. Sin eso la pausa se muestra
 * al final del bloque y no dice nada: lo útil es verla partiendo la frase justo
 * donde el video se queda quieto.
 */
function pausasDelTramo(tramo, silencios, palabrasDentro) {
    const corrimiento = tramo.desdeSec - tramo.origenDesdeSec;
    const redondo = n => Math.round(n * 100) / 100;

    return (silencios || []).reduce((salida, s) => {
        const desde = Math.max(s.desdeSec, tramo.origenDesdeSec);
        const hasta = Math.min(s.hastaSec, tramo.origenHastaSec);
        // Una pausa que empieza antes del bloque solo cuenta por lo que quedó
        // adentro del corte.
        if (hasta <= desde) return salida;

        // La palabra que "se come" el silencio es la que más lo solapa, no la
        // última que arrancó antes. Whisper estira el final de la última palabra
        // dicha hasta que alguien vuelve a hablar: el silencio queda ADENTRO de
        // esa palabra, y anotarlo antes deja el aviso partiendo una frase que en
        // el audio se dice de corrido ("En Spec-Driven ⏸ Development").
        let tras = -1;
        let mejor = 0;
        for (let i = 0; i < palabrasDentro.length; i++) {
            const p = palabrasDentro[i];
            const comun = Math.min(p.hastaSec, hasta + corrimiento) - Math.max(p.desdeSec, desde + corrimiento);
            if (comun > mejor) { mejor = comun; tras = i; }
        }
        // Si ninguna la solapa —el silencio cae en un hueco entre dos— va
        // detrás de la última que ya había sonado.
        if (tras < 0) {
            for (let i = 0; i < palabrasDentro.length; i++) {
                if (palabrasDentro[i].origenSec > desde) break;
                tras = i;
            }
        }

        salida.push({
            desdeSec: redondo(desde + corrimiento),
            hastaSec: redondo(hasta + corrimiento),
            duracionSec: redondo(hasta - desde),
            trasPalabra: tras
        });
        return salida;
    }, []);
}

/**
 * Las palabras de cada bloque, ya en tiempo del corte montado.
 *
 * @param {Array} tramos los de `pista.construir`
 * @param {Array} palabras [{start, end, text}] en tiempo de la grabación
 * @param {Array} [silencios] [{desdeSec, hastaSec}] en tiempo de la grabación
 * @returns {Array} [{indice, blockIndex, view, camara, desdeSec, hastaSec, palabras, pausas}]
 */
export function repartir(tramos, palabras, silencios) {
    const todas = palabras || [];
    let desde = 0;

    return (tramos || []).map(tramo => {
        // Las palabras vienen ordenadas, así que se avanza un puntero en vez de
        // recorrer las 3700 de la clase una vez por bloque.
        while (desde < todas.length && todas[desde].end < tramo.origenDesdeSec) desde++;

        const dentro = [];
        for (let i = desde; i < todas.length; i++) {
            const palabra = todas[i];
            if (palabra.start > tramo.origenHastaSec) break;
            // Se queda la que suena dentro del bloque. Una palabra partida al
            // medio por el borde cuenta como dentro: sacarla dejaría un hueco
            // donde el audio sí dice algo.
            if (palabra.end < tramo.origenDesdeSec) continue;
            const corrimiento = tramo.desdeSec - tramo.origenDesdeSec;
            dentro.push({
                texto: palabra.text,
                // Recortadas al bloque: si no, la aguja llega al final del
                // bloque y la última palabra todavía figura sonando.
                desdeSec: Math.max(tramo.desdeSec, palabra.start + corrimiento),
                hastaSec: Math.min(tramo.hastaSec, palabra.end + corrimiento),
                // El de la grabación se guarda porque es el que anclan las notas.
                origenSec: palabra.start
            });
        }

        return {
            indice: tramo.indice,
            blockIndex: tramo.blockIndex,
            view: tramo.view,
            // El mismo índice que pinta la tira del reproductor: leyendo el
            // panel se reconoce de qué toma es cada bloque sin bajar la vista.
            camara: tramo.camara,
            desdeSec: tramo.desdeSec,
            hastaSec: tramo.hastaSec,
            palabras: dentro,
            pausas: pausasDelTramo(tramo, silencios, dentro)
        };
    });
}

/**
 * Cuál palabra está sonando en un momento del corte.
 *
 * @returns {{bloque:number, palabra:number}|null}
 */
export function enPosicion(bloques, segundo) {
    const lista = bloques || [];
    for (let b = 0; b < lista.length; b++) {
        const bloque = lista[b];
        // El final de un bloque es el comienzo del siguiente, así que el borde
        // pertenece al que empieza. Con el intervalo cerrado ganaba el que
        // termina —van en orden— y al pararse justo en un corte se alumbraba la
        // última palabra del bloque anterior. El último sí incluye su final,
        // que si no el instante donde termina la clase no cae en ninguno.
        const esElUltimo = b === lista.length - 1;
        if (segundo < bloque.desdeSec) continue;
        if (esElUltimo ? segundo > bloque.hastaSec : segundo >= bloque.hastaSec) continue;

        let elegida = -1;
        for (let i = 0; i < bloque.palabras.length; i++) {
            if (bloque.palabras[i].desdeSec > segundo) break;
            elegida = i;
        }
        // Antes de la primera palabra del bloque —el aire de la entrada— no hay
        // ninguna sonando todavía, y alumbrar la primera sería mentir.
        if (elegida < 0) return null;
        return { bloque: bloque.indice, palabra: elegida };
    }
    return null;
}

/** El texto corrido de un bloque, para leerlo o copiarlo. */
export function texto(bloque) {
    return (bloque && bloque.palabras ? bloque.palabras : []).map(p => p.texto).join(' ').trim();
}

/**
 * El tramo de grabación que cubre una selección de palabras, que es a lo que
 * queda anclado un comentario.
 */
export function anclaDe(bloque, desdeIndice, hastaIndice) {
    const palabras = (bloque && bloque.palabras) || [];
    const a = Math.max(0, Math.min(desdeIndice, hastaIndice));
    const b = Math.min(palabras.length - 1, Math.max(desdeIndice, hastaIndice));
    if (!palabras.length || b < a) return null;

    const trozo = palabras.slice(a, b + 1);
    return {
        sourceStartSec: trozo[0].origenSec,
        sourceEndSec: trozo[trozo.length - 1].origenSec,
        texto: trozo.map(p => p.texto).join(' ').trim()
    };
}
