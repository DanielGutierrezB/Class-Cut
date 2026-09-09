'use strict';
/**
 * teclas.js — Qué hace cada tecla en la pantalla de Grabar.
 *
 * La resolución está separada del cableado porque es lo único comprobable sin una
 * pantalla: qué letra cambia a qué vista, y cuándo una tecla no tiene que hacer
 * nada. El cableado —quién escucha, a quién se le pide el cambio— vive en
 * `index.js`.
 *
 * La regla de "no cuando estoy tipeando" es la de siempre, `estaEscribiendo` de
 * `chrome.js`, y no una nueva: ya la comparten los atajos del reproductor y los
 * de la pestaña de cortes, y una segunda copia acá significaría que arreglar una
 * deja las otras comiéndose los espacios del editor. Igual que allá, el oyente va
 * en el documento: el foco lo tiene lo último que se tocó —un botón de vista, la
 * nota de una toma, nada—, así que pedirle a quien graba que haga clic en la lista
 * antes de poder apretar R sería un atajo que no sirve.
 */

/**
 * Con qué letra se elige cada vista.
 *
 * Sale de la INICIAL del nombre de cada vista, calculada de la lista que manda el
 * motor, y no de una tabla escrita acá. Es la diferencia entre un atajo que se
 * adivina y uno que hay que aprender: quien ve los botones "PV R S MG X2" ya sabe
 * qué apretar. Y una vista nueva en `engine/notas-vivo.js` trae su tecla puesta,
 * en vez de pedir que alguien se acuerde de agregarla en un segundo sitio.
 *
 * Si dos vistas empezaran con la misma letra, la letra se la queda la primera y la
 * segunda se queda sin atajo. Es a propósito y es lo único que se puede hacer sin
 * inventar: repartir la letra por turnos haría que la misma tecla cambiara de
 * significado según qué vista tuviera puesta la toma, que es peor que no tener
 * atajo. Hoy no pasa —PV, R, S, MG y X2 empiezan con cinco letras distintas—, y
 * `tests/teclas.test.js` fija que si algún día pasa, el que pierde es el segundo
 * y no el primero.
 *
 * De las cinco letras, cuatro son las que se pidieron: P, R, S y M. La quinta, X
 * para `X2`, no se pidió y va igual: son cinco botones idénticos en la misma fila,
 * y que cuatro tengan tecla y el quinto no convierte un atajo que se entiende
 * solo en uno que hay que recordar con su excepción. Salió de la misma regla que
 * las otras cuatro, así que no es una tecla nueva: es la regla aplicada entera.
 *
 * @param {Array} vistas las de `estado.vistas` ({nombre, …})
 * @returns {Map<string,string>} letra minúscula → nombre de la vista
 */
export function teclasDeVistas(vistas) {
    const mapa = new Map();
    for (const v of vistas || []) {
        const letra = String(v.nombre || '').charAt(0).toLowerCase();
        if (!letra || mapa.has(letra)) continue;
        mapa.set(letra, v.nombre);
    }
    return mapa;
}

/**
 * Qué hay que hacer con una tecla, o null si esta pantalla no la usa.
 *
 * Se contesta un objeto en vez de hacerlo acá mismo para que la decisión se pueda
 * probar sin motor y sin DOM: lo que llega es cómo estaba el teclado y cómo está
 * la pantalla, y lo que sale es el gesto.
 *
 * @param {object} evento { key, metaKey, ctrlKey, shiftKey, altKey }
 * @param {object} donde {
 *   escribiendo: boolean — el foco está en un campo de texto,
 *   grabando: boolean — hay una sesión en curso,
 *   activa: number|null — la toma sobre la que actúan las teclas de vista,
 *   vistas: Array — las del estado }
 * @returns {{que:'vista', vista:string, toma:number}
 *   | {que:'deshacer'|'rehacer'}
 *   | {que:'cerrar-caja'}
 *   | null}
 */
export function queHace(evento, donde) {
    const e = evento || {};
    const d = donde || {};
    const tecla = String(e.key || '');
    const conComando = Boolean(e.metaKey || e.ctrlKey);

    // Adentro de un campo manda el deshacer del texto, que es el que quien está
    // escribiendo un comentario está esperando. Vale para todo lo de acá: las
    // letras de vista escribiendo son letras, no atajos.
    if (d.escribiendo) return null;

    if (conComando && tecla.toLowerCase() === 'z') {
        return { que: e.shiftKey ? 'rehacer' : 'deshacer' };
    }
    // Cualquier otra cosa con Comando o Control es del sistema o del navegador.
    if (conComando || e.altKey) return null;

    if (tecla === 'Escape') return { que: 'cerrar-caja' };

    if (!d.grabando || d.activa == null) return null;
    // Con Shift no: es cómo se escribe la mayúscula, y una tecla de atajo que
    // también funciona con Shift se dispara al empezar a escribir una frase.
    if (e.shiftKey || tecla.length !== 1) return null;
    const vista = teclasDeVistas(d.vistas).get(tecla.toLowerCase());
    return vista ? { que: 'vista', vista, toma: d.activa } : null;
}

/**
 * Sobre qué toma actúan las teclas de vista cuando nadie eligió ninguna.
 *
 * La abierta, que es la que está pasando; y si no hay ninguna abierta —"Pausa" ya
 * cerró y el profesor todavía no retomó—, la última que se cerró, que es la que
 * quien graba tiene delante y sobre la que se está decidiendo. Una descartada
 * nunca: cambiarle la vista a algo que no va al XML no hace nada.
 *
 * @param {object|null} estado el resumen del motor
 * @returns {number|null} el id de la toma, o null si no hay ninguna
 */
export function tomaActiva(estado) {
    if (!estado || !estado.tomas || !estado.tomas.length) return null;
    const abierta = estado.tomas.find(t => t.outMs == null && !t.descartada);
    if (abierta) return abierta.id;
    const vivas = estado.tomas.filter(t => !t.descartada);
    return vivas.length ? vivas[vivas.length - 1].id : null;
}

/**
 * Si una toma todavía puede ser la elegida.
 *
 * Que esté y que vaya al XML. Una descartada no: su tarjeta se pliega sin los
 * botones de vista, así que una tecla ahí cambiaría algo que no se ve cambiar —y
 * es la misma razón por la que `tomaActiva` tampoco la mira—. Una eliminada
 * tampoco, obviamente: ya no hay tarjeta que marcar.
 *
 * Lo usa la ventana para dos cosas y tienen que ser la misma: decidir sobre qué
 * toma cae la tecla y decidir sobre cuál se dibuja la marca. Si se separaran, la
 * marca podría quedar sobre una toma que la tecla ya no toca, que es exactamente
 * la sorpresa que la marca existe para evitar.
 */
export function puedeElegirse(estado, id) {
    if (id == null || !estado || !estado.tomas) return false;
    return estado.tomas.some(t => t.id === id && !t.descartada);
}

/**
 * La toma sobre la que actúan P, R, S, M y X: la que se eligió, o la abierta.
 *
 * "La toma activa" quería decir dos cosas —la que está grabando y la que estoy
 * mirando— y las dos son razonables, así que acá están las dos: por defecto la
 * abierta, que es lo que pasa si nadie hace nada, y la elegida en cuanto alguien
 * hace clic en una tarjeta. Elegir es un gesto explícito y se ve en pantalla
 * (`marcarElegida` en `index.js`); mientras no lo haya, las teclas siguen
 * funcionando como antes, sin pedirle a quien graba que haga clic en la lista
 * para poder apretar R.
 *
 * Una elegida que se descarta, o que se elimina, deja de valer y la tecla vuelve
 * a la abierta: es preferible que el atajo siga funcionando sobre lo que está
 * pasando que dejarlo mudo esperando que alguien se dé cuenta de que su elección
 * se quedó sin toma.
 *
 * @param {object|null} estado el resumen del motor
 * @param {number|null} elegida el id sobre el que se hizo clic, si hubo alguno
 */
export function tomaDeLasTeclas(estado, elegida) {
    return puedeElegirse(estado, elegida) ? elegida : tomaActiva(estado);
}
