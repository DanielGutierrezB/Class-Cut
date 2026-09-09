'use strict';
/**
 * pulso.js — Si hay un botón del mouse apretado, para que nada se rehaga debajo.
 *
 * **El defecto que esto evita no se ve en la pantalla, se ve en el gesto que no
 * pasó.** Un botón apretado con un campo a medio escribir manda dos cosas de una
 * vez: al apretar, el campo pierde el foco y su `change` sale para el motor, y la
 * respuesta vuelve enseguida. Ese repintado cae ENTRE el `mousedown` y el
 * `mouseup`, así que el nodo que recibió el primero ya no está en el documento
 * cuando llega el segundo — y el navegador no dispara ningún `click` si los dos
 * no cayeron en el mismo nodo. El botón se aprieta y no pasa nada, con todo lo
 * demás en verde: el motor escribió bien y la pantalla no miente.
 *
 * Salió de `tomas.js`, donde se descubrió, porque le pasa lo mismo al panel de
 * análisis: la caja del temario se guarda con un botón que también la pliega, y
 * el `change` del `textarea` sale del mismo `mousedown`. Son dos columnas de la
 * misma pantalla con el mismo mouse, así que el pulso es uno solo: apretar en
 * cualquiera de las dos congela las dos, que es exactamente lo que hace falta —
 * el gesto es del editor, no de la columna.
 *
 * Lo que se pierde es un repintado y no un cambio: el motor ya lo escribió, y lo
 * que se ve queda al día en el gesto siguiente o, como mucho, en el empujón que
 * llega tres segundos después.
 */

/** Si hay un botón principal del mouse apretado sobre alguna columna vigilada. */
let apretado = false;
const vigiladas = new WeakSet();

/** Si el repintado tiene que esperar a que se suelte el mouse. */
export function apretando() {
    return apretado;
}

/**
 * Empieza a mirar el pulso sobre una columna. Idempotente: se llama en cada
 * repintado, y el mismo nodo no se engancha dos veces.
 */
export function vigilar(donde) {
    if (!donde || vigiladas.has(donde)) return;
    vigiladas.add(donde);
    // En captura, para que el pulso se encienda aunque el gesto lo atienda algo
    // de adentro; y solo el botón principal, porque el clic derecho abre un
    // diálogo del sistema y su `pointerup` puede no volver nunca.
    donde.addEventListener('pointerdown', e => { if (e.button === 0) apretado = true; }, true);
    // El final se escucha en la ventana y no en la columna por lo mismo que el
    // del arrastre (`empezarAMover` en `palabras.js`): se puede soltar afuera, y
    // un gesto que nunca se diera por terminado congelaría la pantalla para
    // siempre.
    const soltar = () => { apretado = false; };
    for (const fin of ['pointerup', 'pointercancel']) window.addEventListener(fin, soltar);
    window.addEventListener('blur', soltar);
}
