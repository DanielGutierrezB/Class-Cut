/**
 * prproj.js — El botón que empaqueta un curso entero para Premiere.
 *
 * Vive en el cabezal de la carpeta y no en la tarjeta de una clase porque lo que
 * arma es UN proyecto con todas: catorce clases dejaban catorce XML que había que
 * importar de a uno, y un `.prproj` los reemplaza por un doble clic. La unidad de
 * este botón es el curso, y la carpeta es el curso.
 *
 * Está en las dos listas de carpetas que tiene la app, y no dan lo mismo. En
 * Clases empaqueta los XML ya cortados, con sus clips, sus cortes y sus tiempos;
 * en Grabar, los de las notas tomadas en vivo, que son marcadores y nada más. Es
 * el mismo gesto sobre dos cosechas distintas, y por eso el estado es uno solo
 * —abajo— y lo que cambia es apenas cómo se dibuja: `boton()` arma elementos para
 * las tarjetas de Grabar y `botonHtml()` devuelve texto para la tabla de Clases,
 * que se redibuja de una sola cadena.
 *
 * **Es aditivo y hay que mantenerlo así.** El XML sigue siendo la entrega —es lo
 * que abre en Premiere y en Resolve, y es lo que las pruebas protegen—, así que
 * generar el proyecto no reescribe ni borra nada: deja un archivo nuevo al lado.
 * Si un día el formato de Premiere cambia y esto se rompe, lo que se pierde es
 * una comodidad, no el trabajo.
 *
 * Está aparte de `grabadas.js` porque esa ya tiene el largo de un archivo y otro
 * asunto: la lista es de clases y sabe gestionarlas, y esto es del curso.
 */

import { toast } from '../chrome.js';
import { esc, plural } from '../formato.js';

/**
 * Lo que este botón sabe, y por qué NO vive adentro del cabezal.
 *
 * El cabezal se redibuja entero cada vez que la lista se relee, y una generación
 * de un curso de catorce clases tarda lo que tarde el disco. Con el avance
 * guardado en el elemento, el primer repintado se lo llevaba puesto y el botón
 * volvía a decir «Generar» con el trabajo todavía corriendo. Guardado acá, el
 * cabezal se dibuja con el estado de ahora las veces que haga falta.
 *
 * Por carpeta y no una sola: nada impide apretar el botón de un curso mientras
 * otro está a medias, y confundir los dos avances sería peor que no mostrarlos.
 */
const suyo = {
    // ruta de la carpeta → { hecho, total, que }
    generando: new Map(),
    // ruta de la carpeta → { ruta } de lo último que salió bien, para poder
    // ofrecer «Mostrar en el Finder» sin volver a generar.
    hechos: new Map(),
    /**
     * Quién tiene que redibujarse cuando esto cambia.
     *
     * Son varios porque el botón está en dos tablas —la lista de Grabar y la de
     * Clases— y las dos pueden estar dibujadas a la vez. Se avisa a todas y no
     * solo a la de donde salió el clic: son dos vistas del mismo trabajo, y una
     * que se queda diciendo «Generar» mientras la otra cuenta sería mentira.
     */
    pintores: []
};

export function cablear(pintar) {
    if (typeof pintar === 'function' && !suyo.pintores.includes(pintar)) {
        suyo.pintores.push(pintar);
    }
}

function repintar() {
    for (const pintar of suyo.pintores) pintar();
}

/** El avance que manda el motor mientras arma el proyecto. */
export function avance(aviso) {
    if (!aviso || !suyo.generando.has(aviso.carpeta)) return;
    suyo.generando.set(aviso.carpeta, {
        hecho: aviso.hecho, total: aviso.total, que: aviso.que
    });
    repintar();
}

/**
 * Pedir la plantilla, si todavía no hay ninguna.
 *
 * El motor clona un proyecto guardado por el Premiere del editor en vez de
 * escribir el esqueleto a mano, así que hace falta uno. Se pide en el momento en
 * que se necesita y no al arrancar la app: quien nunca aprieta este botón no
 * tiene por qué enterarse de que existe.
 *
 * @returns {Promise<boolean>} si quedó una plantilla usable
 */
async function conseguirPlantilla(estado) {
    const porque = {
        'sin-elegir': 'Para armar el proyecto hace falta una plantilla: un ' +
            '.prproj cualquiera guardado por tu Premiere. De ahí se copia el ' +
            'esqueleto, así el archivo nace con la versión y los ajustes de tu ' +
            'Premiere y no de una copia escrita a mano que envejece.',
        'no-esta': `La plantilla que estaba elegida ya no está en el disco:\n${estado.ruta}`,
        'no-es-archivo': `Lo elegido como plantilla no es un archivo:\n${estado.ruta}`
    }[estado.falta] || 'Hay que elegir una plantilla.';

    const quiere = await window.cc.confirmar({
        titulo: 'Elegir la plantilla de Premiere',
        mensaje: porque,
        ok: 'Elegir…'
    });
    if (!quiere) return false;

    const r = await window.cc.prprojElegirPlantilla();
    if (r.cancelado) return false;
    if (!r.ok) { toast(r.error || 'Ese archivo no sirve de plantilla.'); return false; }
    return true;
}

/**
 * Armar el proyecto de un curso. Es el gesto entero, desde cualquiera de las dos
 * tablas: la de Grabar lo llama desde su botón de DOM y la de Clases desde su
 * `data-prproj`.
 */
export async function pedir(ruta) {
    if (suyo.generando.has(ruta)) return;

    let plantilla = await window.cc.prprojPlantilla();
    if (!plantilla.ok) {
        if (!await conseguirPlantilla(plantilla)) return;
        plantilla = await window.cc.prprojPlantilla();
        if (!plantilla.ok) return;
    }

    suyo.generando.set(ruta, { hecho: 0, total: 0, que: 'Leyendo las clases…' });
    repintar();
    const r = await window.cc.prprojGenerar(ruta);
    suyo.generando.delete(ruta);

    if (!r.ok) {
        toast(r.error || 'No se pudo armar el proyecto.');
        repintar();
        return;
    }
    suyo.hechos.set(ruta, { ruta: r.ruta });
    // Los avisos van con el resultado y no en un cartel aparte, por lo mismo que
    // en el regenerado: un «listo» que se calla las tres clases que no entraron
    // es una pérdida silenciosa.
    const peros = (r.avisos || []).length ? ` · ${r.avisos.join(' · ')}` : '';
    toast(`Proyecto armado con ${plural(r.clases, 'clase', 'clases')}${peros}`);
    repintar();
}

/**
 * Cómo se lee el botón ahora mismo, sin decir de qué está hecho.
 *
 * Las dos tablas lo dibujan distinto —una con DOM y la otra con texto— pero
 * dicen lo mismo, así que el texto se decide en un solo lugar. Que digan cosas
 * distintas del mismo trabajo sería el defecto más fácil de meter acá.
 *
 * @param {string} ruta
 * @param {number} conXml cuántas clases de esa carpeta entran
 */
function comoSeLee(ruta, conXml) {
    const yendo = suyo.generando.get(ruta);
    if (yendo) {
        return {
            yendo: true,
            // El total llega con el primer aviso del motor, no antes: hasta que
            // diga cuántas son, decir «0 de 0» sería inventar una cuenta.
            texto: yendo.total ? `Armando… ${yendo.hecho}/${yendo.total}` : 'Armando…',
            titulo: yendo.que || ''
        };
    }
    return {
        yendo: false,
        texto: 'Generar .prproj',
        titulo: `Arma un proyecto de Premiere con las ${conXml} clases de esta ` +
            'carpeta, cada una en su secuencia. No toca los XML: deja un archivo nuevo al lado.',
        hecho: suyo.hechos.get(ruta) || null
    };
}

/**
 * El botón, con lo que esté pasando puesto.
 *
 * @param {string} ruta la carpeta del curso
 * @param {number} conXml cuántas de sus clases tienen XML, que son las que entran
 * @returns {HTMLElement|null} `null` cuando no hay nada que empaquetar
 */
export function boton(ruta, conXml) {
    if (!conXml) return null;
    const lee = comoSeLee(ruta, conXml);

    const caja = document.createElement('span');
    caja.className = 'carpeta-prproj';

    const b = document.createElement('button');
    b.className = 'btn btn-ghost btn-inline';
    b.type = 'button';
    b.textContent = lee.texto;
    b.title = lee.titulo;
    if (lee.yendo) {
        b.disabled = true;
    } else {
        b.onclick = e => {
            // Un botón dentro de un `summary` abriría y cerraría la tarjeta
            // además de hacer lo suyo.
            e.preventDefault();
            e.stopPropagation();
            pedir(ruta);
        };
    }
    caja.append(b);

    if (lee.hecho) {
        const ver = document.createElement('button');
        ver.className = 'btn btn-ghost btn-inline';
        ver.type = 'button';
        ver.textContent = 'Mostrar';
        ver.title = lee.hecho.ruta;
        ver.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            window.cc.reveal(lee.hecho.ruta);
        };
        caja.append(ver);
    }
    return caja;
}

/**
 * El mismo botón, en texto, para la tabla de Clases.
 *
 * Esa tabla se dibuja como una sola cadena de HTML y no elemento por elemento
 * —las filas se rehacen enteras en cada render y atarlas de a una es trabajo que
 * crece con la cantidad de clases—, así que acá no sirve el de arriba. El clic se
 * atiende por delegación, con `data-prproj` (ver `wireClases`).
 *
 * Y es el caso RICO: los XML de esa pestaña son los cortados, con sus clips y sus
 * tiempos, mientras que los de Grabar son marcadores tomados en vivo.
 *
 * @param {string} ruta la raíz del curso
 * @param {number} conXml cuántas de sus clases ya están cortadas
 */
export function botonHtml(ruta, conXml) {
    if (!conXml) return '';
    const lee = comoSeLee(ruta, conXml);
    const mostrar = lee.hecho
        ? `<button class="btn btn-ghost btn-inline" data-prproj-ver="${esc(lee.hecho.ruta)}"
                   title="${esc(lee.hecho.ruta)}">Mostrar</button>`
        : '';
    return `<span class="carpeta-prproj">
        <button class="btn btn-ghost btn-inline" data-prproj="${esc(ruta)}"
                ${lee.yendo ? 'disabled' : ''}
                title="${esc(lee.titulo)}">${esc(lee.texto)}</button>${mostrar}
    </span>`;
}
