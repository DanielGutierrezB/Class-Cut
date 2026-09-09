'use strict';
/**
 * maqueta/vigia.js — El cartel que avisa que esta pestaña quedó vieja.
 *
 * El servidor sirve todo fresco: los archivos salen del disco en cada pedido y
 * las constantes del motor se releen igual (`motorAlDia` en `tools/maqueta.js`).
 * Pero eso arregla la mitad del problema. La otra mitad es que **una pestaña
 * abierta corre el JavaScript de cuando se abrió**, y la maqueta se deja abierta
 * horas mientras varios agentes cambian el código. Servir bien y mirar viejo da
 * el mismo resultado que servir viejo: un problema que se persigue y no existe.
 *
 * Avisa y no recarga solo, que fue la decisión de acá:
 *
 *   · Recargar solo tira lo que la persona tenía puesto —la pantalla en la que
 *     estaba, el bloque abierto, dónde iba el reproductor—. Con varios agentes
 *     tocando archivos, eso es una pestaña que se reinicia sola cada dos minutos
 *     justo cuando uno está mirando algo.
 *
 *   · El daño que hay que cortar no es "estar viejo", es **no saberlo**. Un
 *     cartel visible lo corta entero y deja que la recarga la elija quien está
 *     mirando, que es quien sabe si está en la mitad de algo.
 *
 *   · Y hay un caso donde recargar no arregla nada: si lo que cambió es
 *     `tools/maqueta.js`, el servidor es el que quedó viejo y hay que
 *     reiniciarlo. Un botón que no cambia nada es peor que ningún botón.
 *
 * Pregunta con una etiqueta `<script>` y no con `fetch`. La CSP que sirve la
 * maqueta es la de la app de verdad —`default-src 'none'; script-src 'self'`—,
 * así que no hay `connect-src` y un `fetch` no sale. Abrirle la CSP sería dejar
 * que la maqueta haga algo que la app no puede, que es exactamente el tipo de
 * mentira que esta maqueta no se permite.
 */

(function () {

// La huella de cuando esta pestaña se cargó, servida junto con las constantes
// del motor por `/maqueta/vistas.js`: es el mismo instante del que salieron.
const AL_ABRIR = window.maquetaHuella;
if (!AL_ABRIR) return;

const CADA_MS = 2000;

/** Lo que se arregla recargando, con el nombre que va en el cartel. */
const RECARGABLE = {
    interfaz: 'la interfaz',
    motor: 'el motor',
    puente: 'el puente'
};

let cartel = null;
/** La huella con la que se apretó la ×: no se vuelve a avisar hasta que cambie. */
let callado = null;

function distinto(ahora, clave) {
    return ahora[clave] !== AL_ABRIR[clave];
}

window.maquetaVigia = function (ahora) {
    const cambiados = Object.keys(RECARGABLE).filter(c => distinto(ahora, c));
    const elServidor = distinto(ahora, 'servidor');
    if (!cambiados.length && !elServidor) return;

    const firma = JSON.stringify(ahora);
    if (firma === callado) return;
    callado = null;

    mostrar(cambiados.map(c => RECARGABLE[c]), elServidor, firma);
};

function enumerar(cosas) {
    if (cosas.length === 1) return cosas[0];
    return `${cosas.slice(0, -1).join(', ')} y ${cosas[cosas.length - 1]}`;
}

/**
 * Chiquito y de una línea, no un cartel.
 *
 * Esto va a estar puesto encima de la pantalla que alguien vino a mirar, y con
 * varios agentes tocando archivos va a aparecer seguido. Un párrafo con botón
 * tapa la barra de acciones de abajo y termina descartado de puro estorbo, que
 * es volver a no avisar. Una pastilla de una línea se ve —es lo único ámbar en
 * una pantalla gris— y no tapa nada que haya que leer. El detalle va en el
 * `title`, para quien pase el mouse.
 */
function mostrar(cambiados, elServidor, firma) {
    if (!cartel) cartel = armar();

    const sePuede = cambiados.length > 0;
    cartel.texto.textContent = sePuede
        ? `↻ cambió ${enumerar(cambiados)}`
        : '⚠ reiniciá la maqueta';
    cartel.texto.title = (sePuede
        ? 'Lo que estás mirando es de antes de ese cambio. Clic acá para recargar.'
        : 'Cambió tools/maqueta.js.')
        + (elServidor ? ' Y el servidor: recargar no alcanza, hay que reiniciarlo.' : '');
    cartel.texto.style.cursor = sePuede ? 'pointer' : 'default';
    cartel.texto.onclick = sePuede ? () => location.reload() : null;

    // Con `display` y no con `hidden`: el atributo lo pisa el `display: flex` que
    // la pastilla lleva puesto, y quedaría visible igual.
    cartel.caja.style.display = 'flex';
    cartel.caja.style.borderColor = elServidor && !sePuede ? '#c2603f' : '#b8933f';

    cartel.cerrar.onclick = () => {
        callado = firma;
        cartel.caja.style.display = 'none';
    };
}

/**
 * La pastilla, armada con la CSSOM y no con `style="…"` ni con una hoja aparte:
 * `style-src 'self'` bloquea el atributo, y una hoja más sería un archivo más
 * que mantener para ocho reglas.
 */
function armar() {
    const caja = document.createElement('div');
    poner(caja, {
        position: 'fixed', zIndex: '2147483647',
        // Abajo a la IZQUIERDA. No hay lugar libre en una pantalla llena, así que
        // se elige qué tapar: la app pone los botones a la derecha de la barra de
        // abajo y el recuento a la izquierda. Tapar un número que se vuelve a leer
        // corriendo el mouse es molesto; tapar el botón con el que se procesa es
        // un cartel que se descarta el primer día.
        left: '12px', bottom: '12px',
        display: 'flex', gap: '6px', alignItems: 'center',
        padding: '4px 6px 4px 10px', borderRadius: '999px',
        background: '#1b1b1f', color: '#e8c877',
        border: '1px solid #b8933f',
        boxShadow: '0 4px 14px rgba(0,0,0,.4)',
        font: '11px/1.6 -apple-system, system-ui, sans-serif',
        whiteSpace: 'nowrap'
    });

    const texto = document.createElement('span');

    const cerrar = document.createElement('button');
    cerrar.type = 'button';
    cerrar.textContent = '×';
    cerrar.title = 'Callar hasta el próximo cambio';
    poner(cerrar, {
        border: '0', background: 'transparent', cursor: 'pointer',
        color: '#e8c877', opacity: '.55', padding: '0 3px',
        font: '13px/1 -apple-system, system-ui, sans-serif'
    });

    caja.append(texto, cerrar);
    document.body.appendChild(caja);
    return { caja, texto, cerrar };
}

function poner(el, reglas) {
    for (const clave of Object.keys(reglas)) el.style[clave] = reglas[clave];
}

/**
 * Una etiqueta por vuelta, y se saca apenas contesta.
 *
 * Se ignora el error a propósito: cuando alguien para el servidor con Ctrl-C,
 * esto falla una vez cada dos segundos, y una consola llena de rojo en la pestaña
 * que uno usa para mirar el diseño es ruido que después se confunde con un
 * problema de la app.
 */
function preguntar() {
    const s = document.createElement('script');
    s.src = `/maqueta/huella.js?t=${Date.now()}`;
    s.onload = s.onerror = () => s.remove();
    document.head.appendChild(s);
}

setInterval(preguntar, CADA_MS);

})();
