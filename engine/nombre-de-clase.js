'use strict';
/**
 * nombre-de-clase.js — Cómo se llama el XML de una clase tomada en vivo.
 *
 *   01_el-curso_2026-09-08_13-01-47        la clase 1
 *   01_p2_el-curso_2026-09-08_15-10-00     su segunda parte, grabada aparte
 *
 * Están las dos mitades acá —armarlo y leerlo— porque son la misma convención y
 * viven en puntas opuestas de la app: lo escribe `grabacion.js` cuando arranca
 * una grabación y lo lee `course-scan.js` meses después, buscando a qué carpeta
 * del Rodecaster corresponde. Con la convención partida en dos archivos, cambiar
 * el formato obliga a acordarse del otro, y el que se olvida no falla: empareja
 * mal, que es peor.
 *
 * **La hora va en el reloj de la pared, no en UTC.** Es la única decisión rara
 * de acá y tiene un motivo concreto: el Rodecaster escribe el arranque de su
 * grabación en el nombre de su carpeta —"Clase 01 - Default_2026-08-18_1_13-01-47"—
 * con la hora local de su reloj, y eso es contra lo que hay que emparejar. Con
 * UTC habría que convertir una de las dos usando la zona de la Mac, y si el
 * Rodecaster tuviera el reloj en otra zona el emparejamiento se correría horas
 * sin que nadie se entere. El instante exacto igual queda guardado: el archivo
 * de al lado lleva `ceroISO` (ver `notas-xml.sidecar`).
 *
 * **La hora es la de "Iniciar grabación"**, que es el análogo de apretar grabar
 * en el Rodecaster. Entre los dos botones hay una demora —de eso se ocupa
 * `align.js` en post—, pero para saber QUÉ carpeta es cuál sobra: entre dos
 * clases hay decenas de minutos.
 *
 * **La parte se escribe `01_p2_`, con el guión bajo.** Es lo que hace que una
 * parte siga siendo la clase 1 para todo lo demás: el número de clase se lee con
 * `/^(\d{1,3})[_\s-]/` (`rodecaster-xml.classNumberFromSequenceName`), así que
 * `01_p2_…` da 1 y `01p2_…` no daría nada. Cuál de las dos partes es cada
 * carpeta lo decide la hora.
 */

const workspace = require('./workspace');

/** Dos dígitos, que es como se ven en la carpeta del Rodecaster ("Clase 01"). */
const DIGITOS = 2;

/** Un nombre nuestro: el número, la parte opcional, el curso, la fecha y la hora. */
const NOMBRE = /^(\d{1,3})_(?:p(\d{1,2})_)?(.*?)_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;

/** Los que se escribieron antes de esto: "01_2609_el-curso-1788571821039". */
const NOMBRE_VIEJO = /^(\d{1,3})[_\s-]/;

function dos(n) {
    return String(n).padStart(DIGITOS, '0');
}

/**
 * El curso, como cabe en un nombre de archivo.
 *
 * Sale del nombre de la carpeta que eligió el editor —una carpeta es un curso—,
 * así que puede traer cualquier cosa: espacios, tildes, barras.
 */
function cursoEnElNombre(curso) {
    return workspace.safeName(curso || 'clase')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'clase';
}

/**
 * @param {object} params { clase, parte, curso, cuandoMs }
 * @returns {string} el nombre, sin extensión
 */
function armar(params) {
    const p = params || {};
    const cuando = new Date(p.cuandoMs != null ? p.cuandoMs : Date.now());
    const fecha = `${cuando.getFullYear()}-${dos(cuando.getMonth() + 1)}-${dos(cuando.getDate())}`;
    const hora = `${dos(cuando.getHours())}-${dos(cuando.getMinutes())}-${dos(cuando.getSeconds())}`;
    // La parte 1 no se escribe: la mayoría de las clases son una sola, y un
    // "_p1_" en todas haría ruido para distinguir el caso raro.
    const parte = Number(p.parte) > 1 ? `p${Math.round(p.parte)}_` : '';
    return `${dos(p.clase || 1)}_${parte}${cursoEnElNombre(p.curso)}_${fecha}_${hora}`;
}

/**
 * Lo que dice un nombre, sea nuestro o de los de antes.
 *
 * Un nombre viejo no lleva hora, y eso no es un error: se devuelve
 * `cuandoMs: null` y quien empareja lo deja para el final (ver `xmlDeNotas` en
 * `course-scan.js`). Sigue teniendo número de clase, que es con lo que se
 * emparejaba antes de que la hora existiera.
 *
 * @param {string} nombre con o sin ".xml"
 * @returns {{clase:number, parte:number, curso:string|null, cuandoMs:number|null}|null}
 */
function leer(nombre) {
    const limpio = String(nombre == null ? '' : nombre).replace(/\.xml$/i, '');

    const m = limpio.match(NOMBRE);
    if (m) {
        const [, clase, parte, curso, y, mo, d, hh, mm, ss] = m;
        return {
            clase: parseInt(clase, 10),
            parte: parte ? parseInt(parte, 10) : 1,
            curso,
            // Sin `Z` ni desfase: se interpreta en la zona de esta máquina, que es
            // la misma en la que se escribió y la misma del reloj del Rodecaster.
            cuandoMs: new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`).getTime()
        };
    }

    const viejo = limpio.match(NOMBRE_VIEJO);
    if (viejo) {
        return { clase: parseInt(viejo[1], 10), parte: 1, curso: null, cuandoMs: null };
    }
    return null;
}

module.exports = { armar, leer, cursoEnElNombre };
