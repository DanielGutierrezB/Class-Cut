'use strict';
/**
 * pegado.js — El scroll de la lista de tomas, pegado al fondo como una consola.
 *
 * Existe porque las tomas van de la más vieja a la más nueva —una clase se lee en
 * el orden en que pasó— y entonces lo último que se dijo queda abajo, fuera de la
 * pantalla en cuanto hay cinco tomas. Así que la lista tiene que seguir sola al
 * fondo, como un `tail -f` o como un chat.
 *
 * Y tiene que dejar de seguir en cuanto alguien sube a leer. Esto es lo que
 * importa de todo el archivo: el estado del motor llega cada tres segundos y
 * repinta, así que un repintado que devuelve el scroll al fondo arranca a quien
 * estaba leyendo la toma 2 cuatro veces por minuto. Se vuelve a engancharse solo
 * al bajar del todo, que es cómo se pide "seguime otra vez" sin un botón.
 */

/**
 * Cuánto se puede estar por encima del fondo y seguir contando como "abajo del
 * todo".
 *
 * No puede ser exacto: `scrollTop + clientHeight === scrollHeight` casi nunca da
 * justo. Las tres medidas salen redondeadas de un layout que es fraccionario, y
 * con el zoom del navegador en 125% o en 200% cada una puede quedar a un pixel de
 * su valor real, así que la diferencia acumulada llega a tres o cuatro sin que
 * nadie haya tocado nada.
 *
 * Ocho, entonces: el doble de ese error, y menos de la mitad de un renglón del
 * texto de una toma —13px con `line-height: 1.7`, o sea unos 22— que es la unidad
 * más chica con la que alguien sube a leer. Cualquier cosa que se pueda explicar
 * por el redondeo cuenta como abajo; subir aunque sea una línea ya cuenta como
 * leer, que es el caso que no se puede pisar.
 */
export const TOLERANCIA = 8;

/**
 * Las medidas que hacen falta para decidir, en un objeto y no leídas del DOM: es
 * lo que deja probar la cuenta sin una pantalla.
 *
 * `finDeLaLista` es dónde termina la lista de tomas DENTRO del que scrollea, y no
 * el largo entero: la columna sigue hacia abajo con las clases ya grabadas, y
 * pegarse a su final dejaría lo último que se dijo arriba, tapado por lo de ayer.
 *
 * @typedef {{arriba:number, alto:number, largo:number, finDeLaLista:number}} Medidas
 */

/**
 * Adónde hay que llevar el scroll para que el final de la lista quede a la vista.
 *
 * @param {Medidas} m
 */
export function fondoDe(m) {
    // El tope del que scrollea manda: pedir más allá no lo mueve más, y contarlo
    // como el objetivo dejaría `estaPegado` en falso para siempre —o sea la lista
    // sin seguir a nadie— justo cuando la lista es más corta que la ventana.
    return Math.max(0, Math.min(m.finDeLaLista - m.alto, m.largo - m.alto));
}

/**
 * Si la vista está abajo del todo, con la tolerancia puesta.
 *
 * @param {Medidas} m
 */
export function estaPegado(m, tolerancia) {
    const cuanta = tolerancia == null ? TOLERANCIA : tolerancia;
    return m.arriba >= fondoDe(m) - cuanta;
}

/**
 * Sigue al fondo mientras nadie suba a leer.
 *
 * @param {Element} donde el que scrollea (la columna de la izquierda)
 * @param {Element} lista la lista de tomas que hay adentro
 * @returns {{alPintar:Function, pegado:Function}} `alPintar` se llama después de
 *   cada repintado; `pegado` dice cómo está, para poder mirarlo desde afuera
 */
export function cablear(donde, lista) {
    // Arranca pegado: entrar al paso es mirar lo que está pasando ahora.
    let pegado = true;
    // Los saltos que hace este módulo generan un `scroll` igual que los de una
    // persona, y no se pueden distinguir por el evento. Se marca antes de saltar:
    // sin esto, un salto que no llega exacto al objetivo —porque el repintado
    // cambió el largo un pixel— se leía como "alguien subió" y la lista se
    // desengancha sola a los pocos segundos.
    let saltando = false;

    const medir = () => ({
        arriba: donde.scrollTop,
        alto: donde.clientHeight,
        largo: donde.scrollHeight,
        finDeLaLista: lista.offsetTop + lista.offsetHeight
    });

    donde.addEventListener('scroll', () => {
        if (saltando) return;
        pegado = estaPegado(medir());
    }, { passive: true });

    return {
        pegado: () => pegado,
        alPintar: () => {
            if (!pegado) return;
            const objetivo = fondoDe(medir());
            if (Math.abs(donde.scrollTop - objetivo) < 1) return;
            saltando = true;
            donde.scrollTop = objetivo;
            // En el turno siguiente: el `scroll` del salto llega después de este
            // renglón, y bajar la bandera acá lo dejaría pasar por movimiento de
            // una persona.
            setTimeout(() => { saltando = false; }, 0);
        }
    };
}
