'use strict';
/**
 * picos.js — Recortar la onda de la clase entera al pedazo que ocupa un bloque.
 *
 * La silueta del audio ya viene medida una vez por clase: `loadReview` pide
 * 1200 cubos del Live-Mix completo y eso viaja en `rev.data.waveform`. Los
 * bloques del corte son tramos de esa misma grabación, así que dibujar la onda
 * de un bloque es quedarse con los cubos que le tocan, no volver a leer disco.
 *
 * Hasta dónde alcanza el recorte, medido sobre la clase 1 del curso real
 * (2516 s, 1200 cubos = 2,1 s por cubo): los quince bloques traen entre 5 y 22
 * cubos.
 * En la tira del reproductor —1217 px para 356 s de corte— eso da unos 7 px por
 * cubo en todos los bloques, que para una silueta de 25 px de alto es una
 * referencia legible. En el panel de abajo del video, donde UN bloque ocupa los
 * 1170 px, los mismos 22 cubos serían 53 px cada uno: ahí el recorte no alcanza
 * y hay que pedir el detalle (ver `onda-clase.js`).
 *
 * Sin estado y sin DOM: esto se prueba solo (`tests/picos.test.js`).
 */

/**
 * Qué cubos de la clase entera caen dentro de un tramo de la grabación.
 *
 * El cubo `i` cubre de `i/n·duración` a `(i+1)/n·duración`, así que la entrada
 * se redondea para abajo y la salida para arriba: recortar por dentro dejaría
 * afuera el arranque del sonido, que es justo lo que se mira en un borde.
 *
 * @returns {{desde:number, hasta:number}} índices, `hasta` sin incluir
 */
export function rangoDePicos(cantidad, duracionSec, desdeSec, hastaSec) {
    const n = Math.max(0, Math.floor(cantidad) || 0);
    if (!n || !(duracionSec > 0)) return { desde: 0, hasta: 0 };

    const porSegundo = n / duracionSec;
    let desde = Math.floor(Math.max(0, desdeSec) * porSegundo);
    let hasta = Math.ceil(Math.min(duracionSec, hastaSec) * porSegundo);
    desde = Math.max(0, Math.min(n - 1, desde));
    hasta = Math.max(0, Math.min(n, hasta));
    // Un tramo más corto que un cubo —o uno invertido, que el plan puede tener
    // mientras el editor arrastra un borde— igual tiene que dar algo dibujable:
    // sin esto la onda del bloque desaparece en vez de verse gruesa.
    if (hasta <= desde) hasta = desde + 1;
    return { desde, hasta };
}

/**
 * Los cubos de un tramo de la grabación.
 *
 * @param {number[]} picos los de la clase entera
 * @param {number} duracionSec cuánto dura la grabación completa
 */
export function recortarPicos(picos, duracionSec, desdeSec, hastaSec) {
    if (!picos || !picos.length) return [];
    const { desde, hasta } = rangoDePicos(picos.length, duracionSec, desdeSec, hastaSec);
    return picos.slice(desde, hasta);
}

/**
 * Contra qué se mide el alto de la silueta, o sea qué pico llena el cuadro.
 *
 * Sin esto la onda es un pelo y no se ve. Medido en el Live-Mix de la clase 1
 * del curso real: el pico más alto de la grabación es 0,179 —unos 15 dB por
 * debajo del techo digital, que es lo normal en una grabación sin masterizar—,
 * el promedio de los 1200 cubos es 0,018 y la mediana 0,004. Dibujado a escala
 * absoluta, un bloque hablado ocupa 3 px de los 84 del panel: una línea con
 * pelusa. Referido al pico de la clase, los quince bloques quedan entre el 22% y
 * el 51% del alto y se lee de un vistazo dónde hay voz y dónde no.
 *
 * El divisor es el de la CLASE ENTERA y no el de cada bloque a propósito: así
 * dos bloques se pueden comparar entre sí, no cambia al mover un borde, y —lo
 * importante— un bloque en silencio se sigue viendo en silencio. Normalizando
 * cada bloque contra sí mismo, el piso de ruido de un bloque callado se estira
 * hasta el techo y se ve como si el profesor hablara todo el tiempo.
 *
 * El mínimo es por eso mismo: 0,02 está por encima de la mediana de los cubos y
 * unos 34 dB abajo del techo. Una clase que no pase de ahí no tiene nada que
 * mostrar, y dividir por su piso convierte el ruido en un código de barras.
 */
export function techoDePicos(picos) {
    let max = 0;
    for (const pico of picos || []) {
        if (pico > max) max = pico;
    }
    return Math.max(0.02, max);
}

/**
 * Los picos repartidos en tantas columnas como se vayan a dibujar.
 *
 * Se queda con el máximo de cada columna y no con el promedio por lo mismo que
 * `engine/waveform.js` mide picos: el promedio aplana los ataques y en la
 * silueta desaparecen las fronteras entre tomas.
 *
 * Sirve en las dos direcciones. Con más columnas que picos —un bloque de 6
 * cubos en 150 px de tira— cada pico se repite en varias columnas y la onda se
 * ve escalonada, que es honesto: es la resolución que hay. Con menos columnas
 * que picos junta, que es el caso del detalle pedido al disco.
 */
export function porColumna(picos, columnas) {
    const n = Math.max(0, Math.floor(columnas) || 0);
    if (!n) return [];
    if (!picos || !picos.length) return new Array(n).fill(0);

    const salida = new Array(n).fill(0);
    for (let x = 0; x < n; x++) {
        const desde = Math.floor((x / n) * picos.length);
        const hasta = Math.max(desde + 1, Math.floor(((x + 1) / n) * picos.length));
        let pico = 0;
        for (let i = desde; i < hasta && i < picos.length; i++) {
            if (picos[i] > pico) pico = picos[i];
        }
        salida[x] = pico;
    }
    return salida;
}
