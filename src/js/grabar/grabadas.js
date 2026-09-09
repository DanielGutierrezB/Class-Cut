'use strict';
/**
 * grabadas.js — Las clases que ya se grabaron, debajo de la que se está grabando.
 *
 * Terminar una clase no la saca de la pantalla: en un día de rodaje se graban
 * varias, y quien toma las notas quiere ver que la 1 y la 2 quedaron antes de
 * arrancar la 3. Cada una es una tarjeta plegada con lo que importa de un
 * vistazo —cuándo fue, cuántas tomas quedaron, cómo se llama su XML— y se
 * despliega para leer las tomas.
 *
 * Se ven de dos maneras. **Por carpeta**: una carpeta de notas es un curso, así
 * que agrupadas por carpeta son las clases de cada curso, con la carpeta en uso
 * primero. **Por fecha**: todas juntas, de la más nueva a la más vieja, que es
 * lo que sirve para ver qué se grabó hoy sin importar de qué curso.
 *
 * Lo que se muestra sale del archivo con la hora del día que cada clase dejó en
 * su carpeta (`grabacion.listar`), no de la memoria de la ventana: la lista son
 * las carpetas, así que la clase de ayer aparece igual que la de hace un minuto.
 *
 * Una clase terminada se edita como una en curso, y por un motivo: revisar el
 * guion entero es justo cuando uno se da cuenta de las cosas —que esa toma iba en
 * S, que sobra, que el conteo se comió la primera frase, qué hay que decirle a
 * quien edita—, y cerrar la clase no puede ser el momento en que todo eso deja de
 * poderse. Cada cambio reescribe su XML en el acto.
 *
 * Los bordes también se arrastran, que es lo que más parecía imposible: el texto
 * de un rango más ancho que cada toma quedó guardado al lado del XML, así que
 * correr el IN o el OUT ahí adentro es repartir de nuevo palabras que ya están
 * (ver `moverBordeGuardado` en `engine/notas-vivo.js`). Lo único que pide volver
 * a oír es irse más lejos que ese rango, y para eso está **regenerar**, que
 * relee las tomas con el modelo grande y deja orillas nuevas alrededor de los
 * bordes de ahora.
 */

import { fmtDur, fmtHora, plural } from '../formato.js';
import { pintarLeida } from './tomas.js';
import { tramosPorToma } from './empalme.js';

export const MODOS = ['carpetas', 'fecha'];

/** El nombre de una carpeta, que es el del curso. */
export function nombreDeCarpeta(ruta) {
    return String(ruta || '').split('/').filter(Boolean).pop() || ruta || '';
}

/**
 * Cómo se lee una clase: "Clase 3", o "Clase 3 · parte 2" si se grabó en tandas.
 *
 * La parte solo aparece cuando la hay. La mayoría de las clases son una sola
 * grabación, y un "parte 1" en todas taparía justo el caso que importa ver.
 */
export function comoSeLlama(clase) {
    const n = clase.clase || '?';
    return `Clase ${n}${clase.parte > 1 ? ` · parte ${clase.parte}` : ''}`;
}

/**
 * Hasta cuándo grabó una clase: el cierre del audio, y si no quedó escrito
 * (la app se cerró de golpe), el final de la última toma.
 */
function finDe(clase) {
    const cierres = (clase.sesiones || []).map(s => s.hastaMs).filter(Boolean);
    if (cierres.length) return Math.max(...cierres);
    const salidas = (clase.tomas || []).map(t => t.outMs).filter(Boolean);
    return salidas.length ? Math.max(...salidas) : null;
}

function dato(texto, clase) {
    const span = document.createElement('span');
    span.className = clase ? `clase-dato ${clase}` : 'clase-dato';
    span.textContent = texto;
    return span;
}

function botonChico(texto, titulo, alClic) {
    const boton = document.createElement('button');
    boton.className = 'btn btn-ghost btn-inline';
    boton.type = 'button';
    boton.textContent = texto;
    if (titulo) boton.title = titulo;
    boton.onclick = e => {
        // Un botón dentro de un `summary` abriría y cerraría la tarjeta además
        // de hacer lo suyo.
        e.preventDefault();
        e.stopPropagation();
        alClic();
    };
    return boton;
}

/**
 * @param {object} clase de `grabacion.listar`
 * @param {object} vista { conCurso, vistas, regenerando: Map json → {hechas,total},
 *   alRegenerar(clase), alEditar(clase, cambio) }
 */
function tarjeta(clase, vista) {
    const caja = document.createElement('details');
    caja.className = 'clase es-hecha';
    caja.dataset.json = clase.archivos ? clase.archivos.json : '';

    const cabeza = document.createElement('summary');
    cabeza.className = 'clase-cabeza';

    const titulo = document.createElement('strong');
    titulo.textContent = comoSeLlama(clase)
        + (vista.conCurso && clase.curso ? ` · ${clase.curso}` : '');
    cabeza.append(titulo);

    const fin = finDe(clase);
    cabeza.append(dato(fin
        ? `${fmtHora(clase.ceroMs)} → ${fmtHora(fin)} · ${fmtDur((fin - clase.ceroMs) / 1000)}`
        : fmtHora(clase.ceroMs)));

    const tomas = clase.tomas || [];
    const quedan = tomas.filter(t => !t.descartada && t.outMs != null).length;
    cabeza.append(dato(quedan === tomas.length
        ? plural(tomas.length, 'toma', 'tomas')
        : `${plural(tomas.length, 'toma', 'tomas')} · quedan ${quedan}`));

    if (clase.claqueta) {
        cabeza.append(dato(`claqueta ${fmtHora(clase.claqueta.ms)}`, clase.claqueta.confirmada ? '' : 'es-duda'));
    } else {
        cabeza.append(dato('sin claqueta', 'es-duda'));
    }

    const xml = document.createElement('span');
    xml.className = 'clase-xml mono';
    xml.textContent = clase.archivos ? nombreDeCarpeta(clase.archivos.xml) : clase.secuencia;
    xml.title = clase.archivos ? clase.archivos.xml : '';
    cabeza.append(xml);

    const marcha = vista.regenerando.get(caja.dataset.json);
    if (marcha) {
        cabeza.append(dato(`Regenerando ${marcha.hechas} de ${marcha.total}…`, 'es-marcha'));
    } else if (tomas.length) {
        cabeza.append(botonChico('Regenerar',
            'Volver a leer todas las tomas del audio con el modelo grande y reescribir el XML',
            () => vista.alRegenerar(clase)));
    }

    const lista = document.createElement('div');
    lista.className = 'grabar-tomas';
    if (!tomas.length) {
        const vacio = document.createElement('p');
        vacio.className = 'toma-vacio';
        vacio.textContent = 'No se abrió ninguna toma.';
        lista.append(vacio);
    }
    // Cambiar una clase terminada reescribe su XML en el acto (`editarGrabada` en
    // `engine/grabacion.js`): quien revisa el guion entero no tiene que acordarse
    // después de regenerar nada. Los dos gestos son los mismos que en vivo —el
    // arrastre de una línea y el clic derecho sobre una palabra—, así que la
    // tarjeta ofrece los dos y no una versión recortada.
    const acciones = clase.archivos
        ? {
            alCambiar: cambio => vista.alEditar(clase, cambio),
            alBorde: donde => vista.alBorde(clase, donde)
        }
        : null;
    // El empalme de una clase terminada se mira igual: `grabacion.listar` lo
    // rehace al leer el archivo, y los bordes de una clase cerrada se mueven, así
    // que el ajuste que se ofrece acá es tan aplicable como el de la que corre.
    // Los tramos se arman con las tomas EN ORDEN, antes de darlas vuelta para
    // dibujarlas: cuál es la anterior lo decide la clase, no la lista.
    const conVistas = { vistas: vista.vistas || [], repetidos: tramosPorToma(tomas) };
    for (const toma of [...tomas].reverse()) lista.append(pintarLeida(toma, conVistas, acciones));

    caja.append(cabeza, lista);
    return caja;
}

/**
 * La cabecera de una carpeta en el modo por carpeta: el curso, dónde está y
 * cuántas clases tiene. La que está en uso lo dice; las demás se pueden sacar de
 * la lista (no del disco).
 */
function cabeceraDeCarpeta(ruta, cuantas, vista) {
    const cabeza = document.createElement('header');
    cabeza.className = 'carpeta-cabeza';
    cabeza.classList.toggle('es-activa', ruta === vista.carpetaActiva);

    const nombre = document.createElement('strong');
    nombre.textContent = nombreDeCarpeta(ruta);
    const ruta_ = document.createElement('span');
    ruta_.className = 'clase-dato mono';
    ruta_.textContent = ruta;
    ruta_.title = ruta;
    cabeza.append(nombre, ruta_, dato(plural(cuantas, 'clase', 'clases')));

    if (ruta === vista.carpetaActiva) {
        cabeza.append(dato('en uso', 'es-en-uso'));
    } else {
        const quitar = botonChico('Quitar de la lista',
            'Deja de mostrarla acá. No borra nada del disco.',
            () => vista.alQuitarCarpeta(ruta));
        quitar.classList.add('carpeta-quitar');
        cabeza.append(quitar);
    }
    return cabeza;
}

/**
 * @param {Element} donde
 * @param {Array} clases de `grabacion.listar`, de la más nueva a la más vieja
 * @param {object} vista {
 *   modo: 'carpetas'|'fecha', carpetas: string[] (la activa primera),
 *   carpetaActiva, vistas, regenerando: Map, alRegenerar(clase),
 *   alEditar(clase, cambio), alBorde(clase, {toma, paredMs}), alQuitarCarpeta(ruta) }
 */
export function pintar(donde, clases, vista) {
    // Con una línea de borde en la mano no se repinta, igual que en la lista de
    // la clase en curso (`tomas.pintar`). Acá hace falta por lo mismo y por un
    // camino distinto: mientras se graba, el estado del motor llega cada tres
    // segundos y repinta la pantalla entera, esta lista incluida. Rehacerla en
    // medio del gesto cambia la línea por otra y el arrastre se corta solo.
    if (donde.querySelector('.toma-borde.es-arrastrando')) return;

    // Qué tarjetas estaban desplegadas, para volver a dejarlas así. Comentar una
    // clase reescribe su XML y relee la lista, y sin esto la tarjeta que se
    // estaba leyendo se cerraba justo al comentarla.
    const abiertas = new Set([...donde.querySelectorAll('details.clase[open]')]
        .map(d => d.dataset.json).filter(Boolean));
    donde.textContent = '';
    const lista = clases || [];
    const conEstado = clase => {
        const caja = tarjeta(clase, { ...vista, conCurso: vista.modo === 'fecha' });
        caja.open = abiertas.has(caja.dataset.json);
        return caja;
    };

    if (vista.modo === 'fecha') {
        for (const clase of lista) donde.append(conEstado(clase));
        return;
    }

    for (const ruta of vista.carpetas || []) {
        const suyas = lista.filter(c => c.carpeta === ruta);
        const grupo = document.createElement('section');
        grupo.className = 'carpeta';
        grupo.append(cabeceraDeCarpeta(ruta, suyas.length, vista));
        if (!suyas.length) {
            const vacio = document.createElement('p');
            vacio.className = 'toma-vacio carpeta-vacia';
            vacio.textContent = ruta === vista.carpetaActiva
                ? 'Todavía no hay clases grabadas acá: la próxima cae en esta carpeta.'
                : 'No quedó ninguna clase en esta carpeta.';
            grupo.append(vacio);
        }
        for (const clase of suyas) grupo.append(conEstado(clase));
        donde.append(grupo);
    }
}
