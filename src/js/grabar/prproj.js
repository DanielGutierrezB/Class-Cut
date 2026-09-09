/**
 * prproj.js — El botón que empaqueta un curso entero para Premiere.
 *
 * Vive en el cabezal de la carpeta y no en la tarjeta de una clase porque lo que
 * arma es UN proyecto con todas: catorce clases dejaban catorce XML que había que
 * importar de a uno, y un `.prproj` los reemplaza por un doble clic. La unidad de
 * este botón es el curso, y la carpeta es el curso.
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
import { plural } from '../formato.js';

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
    pintar: () => {}
};

export function cablear({ pintar }) {
    suyo.pintar = pintar;
}

/** El avance que manda el motor mientras arma el proyecto. */
export function avance(aviso) {
    if (!aviso || !suyo.generando.has(aviso.carpeta)) return;
    suyo.generando.set(aviso.carpeta, {
        hecho: aviso.hecho, total: aviso.total, que: aviso.que
    });
    suyo.pintar();
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

async function generar(ruta) {
    let plantilla = await window.cc.prprojPlantilla();
    if (!plantilla.ok) {
        if (!await conseguirPlantilla(plantilla)) return;
        plantilla = await window.cc.prprojPlantilla();
        if (!plantilla.ok) return;
    }

    suyo.generando.set(ruta, { hecho: 0, total: 0, que: 'Leyendo las clases…' });
    suyo.pintar();
    const r = await window.cc.prprojGenerar(ruta);
    suyo.generando.delete(ruta);

    if (!r.ok) {
        toast(r.error || 'No se pudo armar el proyecto.');
        suyo.pintar();
        return;
    }
    suyo.hechos.set(ruta, { ruta: r.ruta });
    // Los avisos van con el resultado y no en un cartel aparte, por lo mismo que
    // en el regenerado: un «listo» que se calla las tres clases que no entraron
    // es una pérdida silenciosa.
    const peros = (r.avisos || []).length ? ` · ${r.avisos.join(' · ')}` : '';
    toast(`Proyecto armado con ${plural(r.clases, 'clase', 'clases')}${peros}`);
    suyo.pintar();
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

    const caja = document.createElement('span');
    caja.className = 'carpeta-prproj';

    const b = document.createElement('button');
    b.className = 'btn btn-ghost btn-inline';
    b.type = 'button';

    const yendo = suyo.generando.get(ruta);
    if (yendo) {
        b.disabled = true;
        // El total llega con el primer aviso del motor, no antes: hasta que diga
        // cuántas son, decir "0 de 0" sería inventar una cuenta.
        b.textContent = yendo.total
            ? `Armando… ${yendo.hecho}/${yendo.total}`
            : 'Armando…';
        b.title = yendo.que || '';
    } else {
        b.textContent = 'Generar .prproj';
        b.title = `Arma un proyecto de Premiere con las ${conXml} clases de esta ` +
            'carpeta, cada una en su secuencia. No toca los XML: deja un archivo nuevo al lado.';
        b.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            generar(ruta);
        };
    }
    caja.append(b);

    const hecho = !yendo && suyo.hechos.get(ruta);
    if (hecho) {
        const ver = document.createElement('button');
        ver.className = 'btn btn-ghost btn-inline';
        ver.type = 'button';
        ver.textContent = 'Mostrar';
        ver.title = hecho.ruta;
        ver.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            window.cc.reveal(hecho.ruta);
        };
        caja.append(ver);
    }
    return caja;
}
