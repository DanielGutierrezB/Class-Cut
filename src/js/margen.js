'use strict';
/**
 * margen.js — Dónde va cada tarjeta de comentario al margen.
 *
 * Dos pantallas comentan al margen, como en un documento compartido: el guion del
 * visor de cortes y las tomas de la clase que se está grabando. Las dos tienen el
 * mismo problema de acomodo —cada tarjeta quiere estar a la altura de la frase que
 * comenta, y dos frases vecinas piden la misma altura—, así que la cuenta vive en
 * un solo sitio. Es la misma razón por la que `seleccion.js` existe: lo que
 * comparten tres pantallas no puede estar escrito tres veces.
 */

/** Cuánto se separan dos tarjetas que quieren el mismo alto. */
export const AIRE_ENTRE_TARJETAS = 8;

/**
 * Pone cada tarjeta a la altura de lo que comenta, y las que chocan más abajo.
 *
 * Sin el empujón, dos comentarios sobre frases vecinas se dibujan uno encima del
 * otro y el de arriba queda ilegible. Empujar hacia abajo y no repartir a los
 * dos lados mantiene el orden de lectura: la tarjeta nunca aparece antes que su
 * cita.
 *
 * @param {number[]} alturas lo que mide cada tarjeta
 * @param {number[]} pedidos a qué altura la quiere cada una, en orden de lectura
 * @returns {number[]} dónde queda cada una
 */
export function acomodarMargen(alturas, pedidos) {
    const salida = [];
    let piso = 0;
    for (let i = 0; i < pedidos.length; i++) {
        const arriba = Math.max(pedidos[i], piso);
        salida.push(arriba);
        piso = arriba + alturas[i] + AIRE_ENTRE_TARJETAS;
    }
    return salida;
}
