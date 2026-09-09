'use strict';
/**
 * turnos.js — Quedarse con la última respuesta del motor y tirar las atrasadas.
 *
 * Cada gesto de la pantalla de Grabar es un viaje: se le pide el cambio al motor
 * y se dibuja lo que conteste (`vista.estado = await window.cc.grabarEditar(…)`).
 * Con un gesto por vez eso no tiene vuelta, y con dos rápidos sobre tomas
 * distintas sí: el motor los aplica en orden —el canal es uno—, pero las dos
 * respuestas viajan por su cuenta y pueden llegar al revés. La que llega segunda
 * es una FOTO de cómo estaba la sesión antes del segundo cambio, así que
 * guardarla borra de la pantalla algo que ya está escrito en el XML, hasta el
 * empujón siguiente del motor. Y no hace falta ser rápido con las manos para
 * provocarlo: apretar un botón de vista con una nota a medio escribir en otra
 * toma manda DOS pedidos en un solo gesto, porque el campo pierde el foco y su
 * `change` sale junto con el clic.
 *
 * Lo que hay acá es un mostrador de turnos: cada pedido saca el suyo antes de
 * salir, y al volver pregunta si mientras tanto ya se atendió a alguien de más
 * adelante. Si sí, su respuesta no se usa y no pasa nada más — el estado bueno lo
 * puso el otro—.
 *
 * Está aparte de `index.js` por dos motivos. Uno, que así se puede probar sin
 * pantalla y sin motor, que es lo único que se puede probar de una carrera:
 * hacerla fallar de verdad pide demorar una respuesta a mano (ver
 * `tools/probar-repintado.js`). Dos, que la regla vale para TODOS los caminos que
 * guardan estado —el cambio, cerrar la toma, la claqueta, deshacer— y no solo
 * para el primero al que se le vio el problema.
 *
 * Un contador y no la comparación de las fotos: mirar si el estado que llegó es
 * "más nuevo" que el que hay pediría un reloj o una versión del lado del motor, y
 * el orden en que salieron los pedidos ya lo sabe la ventana, que es la que los
 * mandó.
 */

/**
 * Un mostrador. Se hace uno por pantalla: los turnos valen entre sí.
 *
 * @returns {{tomar: () => number, atrasada: (turno: number) => boolean}}
 */
export function mostrador() {
    let dados = 0;
    let atendido = 0;
    return {
        /** El turno de un pedido que sale ahora. */
        tomar: () => ++dados,

        /**
         * ¿Llegó tarde? Y si no, queda como el último atendido.
         *
         * Preguntar tiene efecto a propósito: lo que decide si una respuesta
         * sirve es que sea la más nueva de las que llegaron, así que quien
         * pregunta es quien la va a usar.
         */
        atrasada(turno) {
            if (turno <= atendido) return true;
            atendido = turno;
            return false;
        }
    };
}

/**
 * ¿Este estado empujado es de una clase que ya terminó?
 *
 * El mostrador de arriba sirve para lo que la pantalla PIDE: cada pedido lleva su
 * turno porque la ventana es la que lo mandó. Los avisos del motor
 * (`grabar-aviso`) no se piden, así que no tienen turno, y llegan igual: mientras
 * se cierra una clase el motor relee las últimas tomas con el modelo grande y va
 * empujando el estado en cada una.
 *
 * **El que llega después de que la clase terminó la resucita**, y eso se vio en la
 * app de verdad (`tools/probar-vivo.js`): terminar deja `vista.estado = null`, un
 * aviso de la relectura entra un instante más tarde con `grabando: true`, y la
 * pantalla vuelve a creer que está grabando una clase cuyo XML ya está escrito.
 * De ahí no se sale: "← Clases" se apaga porque cree que hay una toma en curso
 * (`porQueNoSeVuelve` en `pantallas.js`), y la única salida es cerrar la app con
 * la clase ya grabada.
 *
 * Se compara la secuencia y no un booleano "ya terminé": en un día de rodaje se
 * graban varias clases seguidas, y un booleano dejaría muda la que empieza
 * después. La secuencia nombra a UNA clase, así que lo que se tira es
 * exactamente lo que llegó tarde de la que se acaba de cerrar.
 *
 * @param {object|null} estado el que trae el aviso
 * @param {string|null} terminada la secuencia de la clase que ya se cerró
 */
export function esDeLaQueTermino(estado, terminada) {
    if (!terminada || !estado) return false;
    return estado.secuencia === terminada;
}
