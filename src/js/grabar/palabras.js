'use strict';
/**
 * palabras.js — El texto de una toma: sus palabras, sus orillas y sus dos bordes.
 *
 * Salió de `tomas.js` cuando ese archivo pasó de los seiscientos renglones y se
 * volvió tres cosas distintas: la tarjeta, la lista y esto. La frontera es la que
 * el DOM ya tenía: acá está todo lo que vive DENTRO de `.toma-texto` —dibujarlo,
 * arrastrar sus líneas, subrayar lo comentado, seleccionar para comentar— y en
 * `tomas.js` lo que lo rodea.
 *
 * Las palabras van de a una en su propio `span` con su hora del día encima, como
 * en el guion del visor de cortes (`src/js/visor/guion.js`) y por el mismo
 * motivo: sobre eso se puede seleccionar para comentar y se puede hacer clic
 * derecho para mover un borde a una palabra concreta.
 */

import { fmtHora } from '../formato.js';
import { spansSeleccionados } from '../seleccion.js';

/**
 * Las palabras que caen dentro de una selección del texto.
 *
 * Se lee del DOM y no de un rango de tiempo porque lo que el editor seleccionó
 * son palabras en la pantalla: de ahí salen las horas de los extremos, que es
 * lo que se convierte en el largo del marcador.
 *
 * @returns {{desdeMs:number, hastaMs:number, texto:string}|null}
 */
export function seleccion(dentroDe) {
    // Las orillas no: un comentario sobre una palabra que quedó fuera de la toma
    // sería un marcador en un sitio del que no sale ningún bloque.
    const elegidas = spansSeleccionados(dentroDe, '.toma-palabra:not(.es-orilla)');
    if (!elegidas.length) return null;

    const horas = elegidas.map(s => Number(s.dataset.t)).filter(n => !isNaN(n));
    if (!horas.length) return null;
    return {
        desdeMs: Math.min(...horas),
        hastaMs: Math.max(...horas),
        texto: elegidas.map(s => s.textContent.trim()).join(' ').trim()
    };
}

function spanDePalabra(w) {
    const span = document.createElement('span');
    span.className = 'toma-palabra';
    span.dataset.t = w.t;
    span.title = fmtHora(w.t);
    span.textContent = w.texto;
    return span;
}

/* ─── Los dos bordes ─────────────────────────────────────────────────────
 *
 * Lo que se dibuja no es solo la toma: alrededor va, en gris, lo que se dijo
 * justo antes y justo después (las "orillas", que arma `repartir` en
 * `engine/notas-vivo.js`). Entre medio van las dos líneas que marcan dónde
 * empieza y dónde termina, y esas se arrastran.
 *
 * Antes esto era invisible: los bordes existían pero no se veían, y moverlos era
 * hacer clic derecho sobre una palabra y contestar un diálogo de "¿IN u OUT?"
 * sin poder ver qué texto se estaba metiendo o sacando. El clic derecho sigue,
 * que para un salto de doscientas palabras arrastrar no sirve.
 */

const BORDES = {
    in: { clase: 'es-in', que: 'Acá empieza la toma' },
    out: { clase: 'es-out', que: 'Acá termina la toma' }
};

function barraDeBorde(cual, movible) {
    const barra = document.createElement('span');
    barra.className = `toma-borde ${BORDES[cual].clase}`;
    barra.dataset.borde = cual;
    barra.title = movible ? `${BORDES[cual].que}. Arrastrá para moverlo.` : BORDES[cual].que;
    barra.setAttribute('aria-label', cual === 'in' ? 'IN de la toma' : 'OUT de la toma');
    return barra;
}

/**
 * Gris lo que está fuera de los bordes.
 *
 * Se calcula recorriendo lo dibujado y no de los tiempos, para que valga igual
 * mientras se arrastra: la línea ya se movió en la pantalla pero el motor todavía
 * no sabe nada, y lo que tiene que verse es dónde quedaría.
 */
function marcarOrillas(texto) {
    let fuera = true;
    for (const hijo of texto.children) {
        if (hijo.classList.contains('toma-borde')) {
            fuera = hijo.dataset.borde === 'out';
            continue;
        }
        hijo.classList.toggle('es-orilla', fuera);
    }
}

/**
 * Subraya las palabras sobre las que hay un comentario.
 *
 * Un comentario se hace seleccionando un pedazo del texto, así que el subrayado
 * es el gesto con el que se comentó, devuelto. Sin él, el texto se veía igual con
 * comentarios que sin ellos: para saber sobre qué frase era había que leer la
 * cita y volver a buscarla arriba, y con cinco comentarios en una toma larga eso
 * es leer la toma entera cinco veces.
 *
 * Se marca por la hora de cada palabra y no por lo que se seleccionó, porque es
 * la hora lo que el comentario guarda (`comentar` en `engine/notas-vivo.js`) y es
 * de donde salen los extremos del marcador: lo subrayado es exactamente lo que
 * va a llegar subrayado a la secuencia.
 *
 * **Dos comentarios se pueden pisar sobre las mismas palabras**, y el tramo pisado
 * se dibuja distinto —doble línea— en vez de elegir uno de los dos: si se pintara
 * como uno solo, el otro comentario sería invisible hasta que alguien hiciera
 * clic ahí por casualidad. Cada palabra se queda con la lista entera de a qué
 * comentarios pertenece, y hacer clic abre todos los que la cubren.
 */
function marcarComentados(texto, toma) {
    const rangos = (toma.comentarios || []).map(c => [Number(c.desdeMs), Number(c.hastaMs)]);
    if (!rangos.length) return;
    for (const span of texto.querySelectorAll('.toma-palabra')) {
        const t = Number(span.dataset.t);
        const cuales = rangos
            .map(([desde, hasta], i) => (t >= desde && t <= hasta ? i : -1))
            .filter(i => i >= 0);
        if (!cuales.length) continue;
        span.classList.add('es-comentada');
        span.classList.toggle('es-pisada', cuales.length > 1);
        span.dataset.com = cuales.join(' ');
        span.title = cuales.length > 1
            ? `${cuales.length} comentarios acá. Clic para verlos.`
            : 'Hay un comentario acá. Clic para verlo.';
    }
    unirMarcadas(texto);
}

/**
 * Cuando la marca sigue en la palabra de al lado, el espacio de en medio se mete
 * ADENTRO del span.
 *
 * Sin esto, una frase marcada se lee como un código de barras: cada palabra lleva
 * su fondo y los espacios quedan sin pintar. Es el mismo arreglo que en el guion
 * del visor (`renderScript` en `src/js/visor/guion.js`) y por la misma razón por
 * la que allá no se estiran las cajas con márgenes en negativo: el fondo es
 * translúcido, así que al superponerse se duplica y quedan costuras oscuras en
 * cada junta.
 *
 * Sirve para cualquier marca sobre el texto y no solo para los comentarios: el
 * subrayado de aviso del empalme tiene el mismo hueco y el mismo remedio
 * (`grabar/empalme.js`). Lo que cambia entre una marca y otra es cuándo dos
 * palabras vecinas son del MISMO tramo, y eso lo contesta quien llama.
 *
 * @param {string} clase la marca, sin el punto
 * @param {function(Element, Element):boolean} [mismoTramo] si no viene, alcanza
 *   con que las dos palabras estén marcadas
 */
export function unirVecinas(texto, clase, mismoTramo) {
    for (const span of [...texto.querySelectorAll(`.toma-palabra.${clase}`)]) {
        const hueco = span.nextSibling;
        if (!hueco || hueco.nodeType !== Node.TEXT_NODE) continue;
        const sigue = hueco.nextSibling;
        if (!sigue || !sigue.classList || !sigue.classList.contains(clase)) continue;
        if (mismoTramo && !mismoTramo(span, sigue)) continue;
        span.append(hueco);
    }
}

/**
 * El espacio se absorbe solo si las dos palabras están en los MISMOS comentarios.
 * Donde el conjunto cambia —porque ahí arranca o termina uno de dos pisados— el
 * hueco se queda, y está bien que se vea: es el sitio donde el tramo cambia de
 * dueño.
 */
export function unirMarcadas(texto) {
    unirVecinas(texto, 'es-comentada',
        (span, sigue) => (sigue.dataset.com || '') === (span.dataset.com || ''));
}

/** La palabra que quedó después de la línea: su hora es la del borde. */
function palabraDespuesDe(barra) {
    let n = barra.nextElementSibling;
    while (n && !n.classList.contains('toma-palabra')) n = n.nextElementSibling;
    return n;
}

function arrastrarBordes(texto, toma, acciones) {
    for (const barra of texto.querySelectorAll('.toma-borde')) {
        barra.onpointerdown = e => {
            // Sin esto el arrastre selecciona texto, y al soltar se abre la caja
            // de comentario encima de lo que se estaba moviendo.
            e.preventDefault();
            empezarAMover(texto, barra, toma, acciones);
        };
    }
}

/**
 * Arrastrar una línea hasta el hueco entre dos palabras.
 *
 * La línea se mueve EN EL TEXTO mientras se arrastra —no es un fantasma aparte—,
 * así que el renglón se reacomoda solo y se ve exactamente cómo va a quedar. Al
 * soltar se le pide el cambio al motor. Con la clase en curso, el motor relee la
 * toma y siempre deja contexto nuevo de los dos lados; con la clase ya cerrada
 * reparte de nuevo lo que hay guardado, así que la orilla hacia donde se fue el
 * borde se va gastando y volver a llenarla es "Regenerar". Si el motor no acepta
 * el movimiento —un IN más allá del OUT— contesta el mismo estado y el repintado
 * devuelve la línea a su sitio.
 *
 * **Los eventos se escuchan en la ventana y no en la línea**, y no es un detalle
 * de estilo: mover la línea de sitio la saca del documento y la vuelve a meter, y
 * eso suelta la captura del puntero. Con `setPointerCapture` el arrastre avanzaba
 * exactamente una palabra y se trababa ahí, porque el resto de los movimientos se
 * los quedaba lo que hubiera debajo del cursor.
 */
function empezarAMover(texto, barra, toma, acciones) {
    const previa = palabraDespuesDe(barra);
    const desde = previa ? previa.dataset.t : null;
    barra.classList.add('es-arrastrando');
    texto.classList.add('es-moviendo');

    const mover = e => {
        const span = palabraBajo(texto, e.clientX, e.clientY);
        if (!span) return;
        // A qué lado de la palabra: por la mitad, como cualquier cursor de texto.
        // Si ya está de ese lado no se toca, que mover el nodo en cada pixel hace
        // saltar el renglón entero.
        const caja = span.getBoundingClientRect();
        if (e.clientX > caja.left + caja.width / 2) {
            if (barra.previousElementSibling === span) return;
            span.after(barra);
        } else {
            if (barra.nextElementSibling === span) return;
            span.before(barra);
        }
        marcarOrillas(texto);
    };

    const soltar = () => {
        window.removeEventListener('pointermove', mover);
        window.removeEventListener('pointerup', soltar);
        window.removeEventListener('pointercancel', soltar);
        barra.classList.remove('es-arrastrando');
        texto.classList.remove('es-moviendo');

        const palabra = palabraDespuesDe(barra);
        const paredMs = palabra ? palabra.dataset.t : null;
        if (paredMs === null || paredMs === desde) { marcarOrillas(texto); return; }
        acciones.alCambiar({
            tipo: 'borde', toma: toma.id, borde: barra.dataset.borde, paredMs: Number(paredMs)
        });
    };

    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
    window.addEventListener('pointercancel', soltar);
}

function palabraBajo(texto, x, y) {
    const donde = document.elementFromPoint(x, y);
    const span = donde && donde.closest('.toma-palabra');
    return span && texto.contains(span) ? span : null;
}

/**
 * @param {object} toma
 * @param {object|null} acciones si viene, las líneas se arrastran; si no, el texto
 *   se lee y nada más (una clase leída de una carpeta ajena, sin dónde escribir)
 */
export function textoDe(toma, acciones) {
    const texto = document.createElement('div');
    // Sin a quién pedirle el cambio, las líneas se ven igual —dicen de dónde a
    // dónde va la toma— pero no se arrastran, y no pueden aparentarlo.
    texto.className = acciones ? 'toma-texto es-movible' : 'toma-texto';
    const palabra = w => texto.append(spanDePalabra(w), document.createTextNode(' '));

    for (const w of toma.antes || []) palabra(w);
    texto.append(barraDeBorde('in', Boolean(acciones)), document.createTextNode(' '));

    const palabras = toma.palabras || [];
    for (const w of palabras) palabra(w);
    if (!palabras.length) {
        const vacio = document.createElement('span');
        vacio.className = 'toma-vacio';
        vacio.textContent = toma.outMs == null
            ? 'Escuchando…'
            : 'Sin texto: no se oyó a nadie en esta toma.';
        texto.append(vacio, document.createTextNode(' '));
    }

    // Una toma abierta no tiene OUT todavía, y lo que se está diciendo ahora es
    // suyo: dibujarle una línea de salida y una orilla sería inventarle un final.
    if (toma.outMs != null) {
        texto.append(barraDeBorde('out', Boolean(acciones)), document.createTextNode(' '));
        for (const w of toma.despues || []) palabra(w);
    }

    marcarOrillas(texto);
    marcarComentados(texto, toma);
    if (acciones) arrastrarBordes(texto, toma, acciones);
    return texto;
}

/**
 * Clic derecho sobre una palabra: mover un borde a esa palabra.
 *
 * Sigue estando aunque las líneas se arrastren, porque para un salto de
 * doscientas palabras arrastrar no sirve. Es el mismo gesto que en la onda del
 * visor de cortes. Cuál de los dos bordes lo pregunta quien atiende
 * (`preguntarBorde` en `index.js`), y es la misma pregunta en la clase en curso
 * que en una ya grabada: lo que cambia es a qué archivo va el cambio.
 */
export function bordeConElDerecho(texto, toma, acciones) {
    if (!acciones.alBorde) return;
    texto.oncontextmenu = e => {
        const span = e.target.closest('.toma-palabra');
        if (!span) return;
        e.preventDefault();
        acciones.alBorde({ toma: toma.id, paredMs: Number(span.dataset.t), abierta: toma.outMs == null });
    };
}
