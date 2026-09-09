'use strict';
/**
 * tomas.js — La lista de tomas, dibujada.
 *
 * Lo que se ve es el estado que manda el motor, sin copia local: la vista no
 * guarda nada suyo, así que lo que está en pantalla y lo que se acaba de
 * escribir en el XML son la misma cosa. Cambiar algo es pedirle el cambio al
 * motor y volver a dibujar con lo que conteste.
 *
 * Las palabras van de a una en su propio `span` con su hora del día encima, como
 * en el guion del visor de cortes (`src/js/visor/guion.js`) y por el mismo
 * motivo: sobre eso se puede seleccionar para comentar y se puede hacer clic
 * derecho para mover un borde a una palabra concreta.
 */

import { fmtDur, fmtHora } from '../formato.js';
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

/**
 * La caja para escribir el comentario, pegada a la toma que se comentó.
 *
 * Igual que en el guion del visor: cita lo seleccionado arriba, para que se vea
 * sobre qué se está comentando cuando la selección se pierda al hacer clic en el
 * campo.
 */
function abrirCaja(dentroDe, ancla, acciones, tomaId) {
    const previa = dentroDe.querySelector('.toma-caja');
    if (previa) previa.remove();

    const caja = document.createElement('div');
    caja.className = 'toma-caja';

    const cita = document.createElement('div');
    cita.className = 'toma-caja-cita';
    cita.textContent = `«${ancla.texto}»`;

    const campo = document.createElement('textarea');
    campo.className = 'toma-caja-campo';
    campo.rows = 2;
    campo.placeholder = 'Tu comentario para el editor…';

    const botones = document.createElement('div');
    botones.className = 'toma-caja-acciones';
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary btn-inline';
    ok.type = 'button';
    ok.textContent = 'Comentar';
    ok.onclick = () => {
        const texto = campo.value.trim();
        if (!texto) return;
        caja.remove();
        window.getSelection().removeAllRanges();
        acciones.alCambiar({ tipo: 'comentar', toma: tomaId, ...ancla, comentario: texto });
    };
    const no = document.createElement('button');
    no.className = 'btn btn-ghost btn-inline';
    no.type = 'button';
    no.textContent = 'Cancelar';
    no.onclick = () => { caja.remove(); };
    botones.append(ok, no);

    caja.append(cita, campo, botones);
    dentroDe.append(caja);
    campo.focus();
}

function spanDePalabra(w) {
    const span = document.createElement('span');
    span.className = 'toma-palabra';
    span.dataset.t = w.t;
    span.title = fmtHora(w.t);
    span.textContent = w.texto;
    return span;
}

/* ─── Las piezas de una toma ─────────────────────────────────────────────
 *
 * Separadas porque una toma se dibuja de dos maneras: la de la clase que se está
 * grabando (`pintarToma`) y la de una que ya terminó (`pintarLeida`). Muestran lo
 * mismo y se les puede hacer lo mismo; lo único que cambia son los dos botones
 * que solo tienen sentido con el ciclo de señales corriendo, "Cerrar acá" y
 * "Reabrir".
 */

function tarjetaDe(toma) {
    const caja = document.createElement('article');
    caja.className = 'toma';
    caja.classList.toggle('es-descartada', Boolean(toma.descartada));
    caja.classList.toggle('es-abierta', toma.outMs == null);
    caja.dataset.vista = toma.vista;
    caja.dataset.toma = toma.id;
    return caja;
}

function cabezaDe(toma) {
    const cabeza = document.createElement('header');
    cabeza.className = 'toma-cabeza';

    const n = document.createElement('span');
    n.className = 'toma-n';
    n.textContent = `Toma ${toma.id}`;

    const cuando = document.createElement('span');
    cuando.className = 'toma-cuando';
    cuando.textContent = toma.outMs == null
        ? `${fmtHora(toma.inMs)} → grabando`
        : `${fmtHora(toma.inMs)} → ${fmtHora(toma.outMs)} · ${fmtDur((toma.outMs - toma.inMs) / 1000)}`;

    cabeza.append(n, cuando);
    return cabeza;
}

/**
 * La marca de "descartada" en la cabecera. Una toma descartada se pliega sobre
 * sí misma —solo la cabecera, sin texto ni nota—: sigue en la lista porque se
 * puede recuperar, pero no puede ocupar el sitio de las que sí van.
 */
function marcaDeDescartada() {
    const marca = document.createElement('span');
    marca.className = 'toma-descartada';
    marca.textContent = 'descartada';
    return marca;
}

/** Los avisos que el motor dejó sobre la toma; los que no vienen no se dibujan. */
function avisosDe(toma) {
    const avisos = [];
    const aviso = (texto, clase) => {
        const p = document.createElement('p');
        p.className = clase ? `toma-aviso ${clase}` : 'toma-aviso';
        p.textContent = texto;
        avisos.push(p);
    };
    if (toma.cerradaSola) aviso('Se cerró sola: nadie dijo "Pausa" antes de la toma siguiente o de terminar.');
    if (toma.repiteA) aviso(`Empieza igual que la toma ${toma.repiteA}: probablemente la repite.`, 'es-repite');
    if (toma.pausaAdentro) {
        aviso(`Hay un "Pausa" adentro, a las ${fmtHora(toma.pausaAdentro)}. ` +
            'Con clic derecho sobre esa palabra se corta el OUT ahí.');
    }
    return avisos;
}

/* ─── El texto, sus orillas y los dos bordes ─────────────────────────────
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
 * Un comentario se hace seleccionando un pedazo del texto, y hasta acá lo único
 * que quedaba de esa selección era la cita en la fila de abajo. O sea que el
 * texto se veía igual con comentarios que sin ellos: para saber sobre qué frase
 * era había que leer la cita y volver a buscarla arriba, y con cinco comentarios
 * en una toma larga eso es leer la toma entera cinco veces. El marcador que se
 * escribe en el XML sí abarca esas palabras, así que la pantalla estaba
 * mostrando menos de lo que ya sabía.
 *
 * Se marca por la hora de cada palabra y no por lo que se seleccionó, porque es
 * la hora lo que el comentario guarda (`comentar` en `engine/notas-vivo.js`) y es
 * de donde salen los extremos del marcador: lo subrayado es exactamente lo que
 * va a llegar subrayado a la secuencia.
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
        // Cuál de los comentarios, para poder resaltar solo el suyo al pasar por
        // encima de una fila. Pueden ser varios: dos comentarios se pueden pisar.
        span.dataset.com = cuales.join(' ');
    }
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
 * @param {object|null} acciones si viene, las líneas se arrastran; si no, el texto
 *   se lee y nada más (una clase leída de una carpeta ajena, sin dónde escribir)
 */
function textoDe(toma, acciones) {
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
 * Seleccionar un pedazo del texto abre la caja para comentarlo.
 *
 * Se mira en el turno siguiente porque durante el `mouseup` la selección todavía
 * no está cerrada y sale vacía.
 */
function comentarSeleccion(caja, texto, acciones, tomaId) {
    texto.onmouseup = () => {
        setTimeout(() => {
            const elegido = seleccion(texto);
            if (elegido) abrirCaja(caja, elegido, acciones, tomaId);
        }, 0);
    };
}

/**
 * Los comentarios sobre pedazos del texto, una fila cada uno.
 *
 * Pasar por encima de una fila resalta arriba las palabras que son suyas. Con un
 * comentario el subrayado ya alcanza, pero con varios todos se ven igual y la
 * cita se corta: la fila es lo que dice cuál es cuál.
 *
 * @param {HTMLElement} texto sobre el que se resalta; `marcarComentados` ya dejó
 *   en cada palabra a qué comentarios pertenece
 */
function comentariosDe(toma, texto) {
    return (toma.comentarios || []).map((c, i) => {
        const fila = document.createElement('p');
        fila.className = 'toma-com';
        const que = document.createElement('span');
        que.className = 'toma-com-que';
        que.textContent = c.comentario;
        const donde = document.createElement('span');
        donde.className = 'toma-com-donde';
        donde.textContent = `«${c.texto}»`;
        fila.append(que, donde);

        const suyas = () => texto.querySelectorAll(`.toma-palabra[data-com~="${i}"]`);
        fila.onmouseenter = () => {
            fila.classList.add('es-mirando');
            for (const s of suyas()) s.classList.add('es-mirando');
        };
        fila.onmouseleave = () => {
            fila.classList.remove('es-mirando');
            for (const s of suyas()) s.classList.remove('es-mirando');
        };
        return fila;
    });
}

/** Las filas de comentarios con su "Quitar", que solo va donde se puede quitar. */
function filasDeComentarios(toma, texto, acciones) {
    return comentariosDe(toma, texto).map((fila, i) => {
        if (!acciones) return fila;
        const quitar = document.createElement('button');
        quitar.className = 'btn btn-ghost btn-inline';
        quitar.type = 'button';
        quitar.textContent = 'Quitar';
        quitar.onclick = () => acciones.alCambiar({ tipo: 'borrar-comentario', toma: toma.id, indice: i });
        fila.append(quitar);
        return fila;
    });
}

/**
 * Las vistas como botones y no como desplegable: la elegida se ve sin abrir
 * nada, que es lo que hace falta cuando hay veinte tomas y hay que encontrar
 * las del screen recorder de un vistazo. Cada botón lleva el color de su vista,
 * el mismo del borde de la toma.
 */
function selectorDeVistas(toma, vistas, acciones) {
    const grupo = document.createElement('div');
    grupo.className = 'toma-vistas';
    grupo.setAttribute('role', 'radiogroup');
    grupo.setAttribute('aria-label', 'Qué vista se usa en esta toma');
    for (const v of vistas) {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'toma-vista-btn';
        boton.classList.toggle('is-elegida', v.nombre === toma.vista);
        boton.dataset.vista = v.nombre;
        boton.textContent = v.nombre;
        boton.title = v.titulo;
        boton.setAttribute('role', 'radio');
        boton.setAttribute('aria-checked', String(v.nombre === toma.vista));
        boton.onclick = () => acciones.alCambiar({ tipo: 'vista', toma: toma.id, vista: v.nombre });
        grupo.append(boton);
    }
    return grupo;
}

/**
 * Una toma de una clase que ya terminó.
 *
 * Se le puede hacer lo mismo que a una en curso, líneas de IN y OUT incluidas. Es
 * la misma línea que traza `vivo.aplicar` del lado del motor, y de ahí sale que
 * todo funcione igual con la clase abierta que cerrada: darse cuenta de que una
 * toma iba en S, o de que el conteo se comió la primera frase, pasa mirando el
 * guion entero, que es justo cuando la clase ya terminó. Lo que se guardó al lado
 * del XML es un rango más ancho que cada toma, así que correr un borde ahí adentro
 * no relee nada.
 *
 * Lo único que queda afuera es "Reabrir", que sin el ciclo de señales corriendo
 * dejaría la toma sin OUT y por lo tanto fuera del XML.
 *
 * @param {object} toma como quedó en el archivo con la hora del día (`sidecar`)
 * @param {object} estado por `vistas`; lo demás no hace falta con la clase cerrada
 * @param {object|null} [acciones] { alCambiar(comando), alBorde({toma, paredMs}) };
 *   sin esto se lee y nada más
 */
export function pintarLeida(toma, estado, acciones) {
    return dibujar(toma, estado, acciones || null, false);
}

/**
 * Una toma de la clase que se está grabando, con todo lo que se le puede hacer.
 *
 * @param {object} toma del estado del motor
 * @param {object} estado el resumen entero, por `vistas`, `tomas` y `abierta`
 * @param {object} acciones { alCambiar(comando), alCerrar(), alBorde({toma, paredMs}) };
 *   los comandos son los de `editar` en `engine/grabacion.js`
 */
function pintarToma(toma, estado, acciones) {
    return dibujar(toma, estado, acciones, true);
}

/**
 * @param {boolean} enVivo si la clase se está grabando ahora. Es lo único que
 *   cambia entre las dos maneras de dibujar una toma, y ya solo cambia los dos
 *   botones del ciclo de señales: "Cerrar acá" y "Reabrir".
 */
function dibujar(toma, estado, acciones, enVivo) {
    const caja = tarjetaDe(toma);
    const cabeza = cabezaDe(toma);

    // Sin nada que hacerle —una clase terminada que solo se lee— se dibuja lo que
    // dice y se acaba: los botones y el campo no pueden estar ahí sin funcionar.
    if (!acciones) {
        if (toma.descartada) {
            cabeza.append(marcaDeDescartada());
            caja.append(cabeza);
            return caja;
        }
        caja.append(cabeza, ...avisosDe(toma));
        if (toma.comentario) {
            const nota = document.createElement('p');
            nota.className = 'toma-nota-leida';
            nota.textContent = toma.comentario;
            caja.append(nota);
        }
        const soloLeer = textoDe(toma, null);
        caja.append(soloLeer, ...filasDeComentarios(toma, soloLeer, null));
        return caja;
    }

    const tirar = document.createElement('button');
    tirar.className = 'btn btn-ghost btn-inline';
    tirar.type = 'button';
    tirar.textContent = toma.descartada ? 'Recuperar' : 'Descartar';
    // Descartar es explícito: "Retomamos" no descarta la anterior sola,
    // porque a veces se retoma para agregar y no para repetir.
    tirar.onclick = () => acciones.alCambiar({
        tipo: 'descartar', toma: toma.id, descartada: !toma.descartada
    });

    if (toma.descartada) {
        cabeza.append(marcaDeDescartada(), tirar);
        caja.append(cabeza);
        return caja;
    }

    cabeza.append(selectorDeVistas(toma, estado.vistas || [], acciones));

    if (enVivo && toma.outMs == null) {
        const cerrar = document.createElement('button');
        cerrar.className = 'btn btn-ghost btn-inline';
        cerrar.type = 'button';
        cerrar.textContent = 'Cerrar acá';
        cerrar.onclick = () => acciones.alCerrar();
        cabeza.append(cerrar);
    } else {
        cabeza.append(tirar);

        // Reabrir solo la última, y solo si no hay otra abierta: es lo único que
        // el motor honra, porque dos tomas abiertas a la vez rompen el ciclo de
        // señales (ver `editar` en `engine/grabacion.js`). Ofrecer el botón donde
        // no va a hacer nada es peor que no ofrecerlo.
        const ultima = estado.tomas ? estado.tomas[estado.tomas.length - 1] : null;
        if (enVivo && toma === ultima && !estado.abierta) {
            const reabrir = document.createElement('button');
            reabrir.className = 'btn btn-ghost btn-inline';
            reabrir.type = 'button';
            reabrir.textContent = 'Reabrir';
            reabrir.title = 'Si "Pausa" cerró de más, la toma sigue';
            reabrir.onclick = () => acciones.alCambiar({ tipo: 'reabrir', toma: toma.id });
            cabeza.append(reabrir);
        }
    }

    caja.append(cabeza, ...avisosDe(toma));

    const nota = document.createElement('input');
    nota.className = 'toma-nota';
    nota.type = 'text';
    nota.placeholder = 'Comentar';
    nota.value = toma.comentario || '';
    // Al salir del campo y no en cada tecla: cada cambio reescribe el XML.
    nota.onchange = () => acciones.alCambiar({ tipo: 'nota', toma: toma.id, texto: nota.value });
    caja.append(nota);

    // Los bordes se mueven igual con la clase abierta que cerrada: correrlos
    // dentro de las orillas guardadas es repartir de nuevo palabras que ya están,
    // no volver a oír (ver `moverBordeGuardado` en `engine/notas-vivo.js`).
    const texto = textoDe(toma, acciones);
    if (acciones.alBorde) {
        // Clic derecho sobre una palabra: mover un borde a esa palabra. Sigue
        // estando aunque las líneas se arrastren, porque para un salto de
        // doscientas palabras arrastrar no sirve. Es el mismo gesto que en la
        // onda del visor de cortes.
        texto.oncontextmenu = e => {
            const span = e.target.closest('.toma-palabra');
            if (!span) return;
            e.preventDefault();
            acciones.alBorde({ toma: toma.id, paredMs: Number(span.dataset.t) });
        };
    }

    comentarSeleccion(caja, texto, acciones, toma.id);
    caja.append(texto, ...filasDeComentarios(toma, texto, acciones));
    return caja;
}

/**
 * La tarjeta que no se puede rehacer: aquella en la que alguien está escribiendo.
 *
 * Vale tanto por el foco como por la caja de comentario abierta, porque la caja
 * se puede perder el foco sin cerrarse —haciendo clic en la cita, por ejemplo— y
 * rehacerla igual borraría lo escrito y la selección sobre la que se comentaba.
 */
function tarjetaOcupada(donde) {
    const foco = document.activeElement;
    for (const tarjeta of donde.children) {
        if (!tarjeta.dataset || !tarjeta.dataset.toma) continue;
        if (tarjeta.contains(foco) || tarjeta.querySelector('.toma-caja')) return tarjeta;
    }
    return null;
}

/**
 * Deja la lista igual a `nuevas` sin sacar del documento lo que ya está bien.
 *
 * Rehacerla entera es una línea —`donde.textContent = ''`, que es lo que había—
 * y el problema es que sacar del documento el campo donde alguien está
 * escribiendo le quita el foco. Con el estado del motor llegando cada tres
 * segundos, comentar una toma mientras la clase seguía era imposible: a media
 * frase el cursor se iba solo y lo escrito se perdía.
 */
function acomodar(donde, nuevas) {
    for (const vieja of [...donde.children]) {
        if (!nuevas.includes(vieja)) vieja.remove();
    }
    let ref = donde.firstElementChild;
    for (const nodo of nuevas) {
        if (nodo === ref) { ref = ref.nextElementSibling; continue; }
        donde.insertBefore(nodo, ref);
    }
}

/**
 * Dibuja la lista entera de la clase en curso.
 *
 * De la más nueva a la más vieja: la que importa mirar es la que está pasando, y
 * con veinte tomas la de arriba tendría que buscarse con la barra.
 *
 * La tarjeta que se está escribiendo se queda como está hasta que suelten el
 * foco. O sea que su texto deja de crecer un rato: es a propósito, porque quien
 * está escribiendo un comentario está mirando su comentario, y a cambio no se le
 * mueve el suelo. Lo que se está oyendo sigue a la vista arriba, en "Oyendo:".
 */
export function pintar(donde, estado, acciones) {
    // Con una línea de borde en la mano no se repinta. El estado del motor llega
    // cada tres segundos, y rehacer la lista en medio del gesto cambia la línea
    // por otra: el arrastre se cortaba solo, a mitad de camino y sin avisar.
    if (donde.querySelector('.toma-borde.es-arrastrando')) return;

    if (!estado || !estado.tomas.length) {
        const vacio = document.createElement('p');
        vacio.className = 'grabar-vacio';
        vacio.textContent = estado
            ? 'Todavía no hay tomas. La primera se abre cuando el profesor cuenta "3, 2, 1" o dice "Retomamos".'
            : 'Elegí la entrada de audio y la carpeta donde guardar, y apretá "Iniciar grabación".';
        acomodar(donde, [vacio]);
        return;
    }

    const ocupada = tarjetaOcupada(donde);
    acomodar(donde, [...estado.tomas].reverse().map(toma =>
        ocupada && Number(ocupada.dataset.toma) === toma.id
            ? ocupada
            : pintarToma(toma, estado, acciones)));
}
