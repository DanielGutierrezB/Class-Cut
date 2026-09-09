'use strict';
/**
 * insistir.js — Qué hacer cuando el sistema se lleva a whisper-cli en medio de
 * una toma.
 *
 * **El material es irrepetible y de ahí sale todo lo de acá.** La clase ya se
 * grabó, el profesor se fue, y no se vuelve a dar. Así que el peor resultado
 * posible no es un texto peor: es una toma sin texto y nadie enterándose hasta
 * que el editor abre el guion tres semanas después. Salió de una corrida de
 * verdad —una clase de veinte minutos con el modelo grande dejó una toma sin
 * releer— y hasta hoy la app no hacía nada: la toma se quedaba con el texto del
 * ciclo de señales, que está declarado descartable, y en pantalla no cambiaba
 * nada.
 *
 * La decisión es: **reintentar esa toma sola, y si vuelve a fallar bajar de
 * modelo, dejando dicho lo que pasó.** Este archivo es la regla; el que la
 * obedece es `engine/oir-toma.js`, que es la puerta por la que se vuelve a oír
 * una toma tanto en una clase en curso como en una que se manda a regenerar.
 *
 * Puro: no oye, no escribe y no espera. Recibe cómo se murió y contesta qué
 * hacer, así que la política entera se puede probar sin un WAV y sin un modelo.
 */

/**
 * Cada cuánto corre el ciclo de señales, y cuánto tarda una de sus pasadas.
 *
 * Los dos son de otros archivos —`grabacion.CICLO_MS` y el segundo largo que
 * `oir.js` midió con nuestro binario— y están acá porque de ellos sale la espera
 * y no de un número elegido. Copiados y no requeridos para no cerrar el círculo
 * `grabacion → relecturas → oir-toma → insistir → grabacion`, que en Node deja a
 * uno de los cinco viéndose a medio cargar. Que no se separen del original lo
 * cuida una prueba que requiere los dos y compara (`tests/insistir.test.js`).
 */
const CICLO_MS = 3000;
const PASADA_MS = 1250;

/**
 * Cuánto se espera antes de volver a intentar la misma toma con el mismo modelo.
 *
 * **No es un número redondo y no puede serlo.** Cuando a whisper-cli lo mata una
 * señal en esta app, lo que casi siempre lo mató es la memoria: el modelo grande
 * son 1,5 GB de pesos mapeados, y mientras se graba hay OTRO whisper-cli con su
 * propia copia corriendo cada tres segundos para oír "3, 2, 1" y "Pausa". El pico
 * de los dos juntos no es permanente: aparece y desaparece al ritmo del ciclo de
 * señales, que arranca cada `CICLO_MS` y ocupa `PASADA_MS` de cada uno.
 *
 * Así que reintentar al instante es reintentar adentro de la misma pasada que
 * acaba de matarlo, y volver a morir no diría nada nuevo. Y esperar de más es
 * peor de otra manera: esta fila es la que decide dónde arrancan las tomas
 * siguientes, así que cada segundo regalado acá se lo cobra la clase en curso.
 *
 * El mínimo que garantiza caer AFUERA del pico es un período entero más una
 * pasada: menos que eso puede caer dentro de la misma ventana ocupada. Son 4,25 s
 * sobre una fila que tarda uno o dos segundos por toma, que es lo que se puede
 * pagar sin atrasar nada.
 */
const ESPERA_MS = CICLO_MS + PASADA_MS;

/**
 * Cómo se murió, en las tres respuestas que cambian lo que hay que hacer.
 *
 *   'senal'   el sistema se lo llevó por delante. Casi siempre memoria, y casi
 *             siempre transitorio: hay algo que ceder y por eso se insiste.
 *   'codigo'  whisper.cpp contestó que no puede con esto. Es determinista —mismo
 *             binario, mismo audio, mismo modelo, misma respuesta— así que
 *             repetirlo igual es tirar una pasada del modelo grande a la basura.
 *   null      no llegó a correr: falta el binario, falta el modelo, el `spawn`
 *             se cayó. No es un problema de esta toma ni de esta máquina cargada,
 *             es de configuración, y bajar de modelo no lo arregla.
 *
 * @param {Error} err el que largó `transcribe.runWhisper`
 */
function comoSeMurio(err) {
    const muerte = err && err.muerte;
    return muerte && muerte.como ? muerte.como : null;
}

/**
 * Qué hacer con la toma que acaba de quedarse sin lectura.
 *
 * **La reacción depende de cómo se murió, y esa es la mitad del criterio que
 * antes no se podía tener**: hasta que el segundo parámetro del `close` dejó de
 * tirarse, las dos salidas llegaban como la misma frase y no había con qué
 * distinguirlas. Ahora sí, y se arreglan distinto:
 *
 * **Una señal se insiste UNA vez y con el mismo modelo.** Ese único reintento
 * pone a prueba una hipótesis concreta y falsable: que lo que lo mató fue la
 * competencia por la memoria y que ya pasó. Un segundo reintento idéntico no
 * pondría a prueba nada nuevo —si esperar un ciclo entero no alcanzó, esperar
 * otro tampoco va a alcanzar—; lo que cambia las probabilidades es bajar los
 * pesos residentes, y eso es el escalón de abajo. Así que se insiste una vez y
 * después se cambia de modelo.
 *
 * **Un código no se reintenta nunca con el mismo modelo.** Es la respuesta de un
 * programa determinista: el modelo que no se abre no se va a abrir, el WAV que no
 * se decodifica no se va a decodificar. Repetirlo cuesta una pasada completa del
 * modelo grande —diez a setenta segundos— en la fila que decide dónde arrancan
 * las tomas de la clase que se está grabando, y compra exactamente nada. Se
 * cambia de modelo en el acto y sin esperar: no hay nada que esperar a que ceda.
 *
 * **Y después de bajar, un intento por escalón.** Una vez que la máquina demostró
 * que no aguanta este modelo, cada escalón es una hipótesis nueva y se le da un
 * intento; insistir dos veces con el mismo modelo liviano volvería a probar lo
 * que ya se probó. Termina siempre: los escalones son finitos y cada uno pesa
 * estrictamente menos que el anterior.
 *
 * @param {object} paso
 *   muerte      lo que devolvió `comoSeMurio`
 *   conElBueno  si el intento que se murió fue con el modelo que se quería usar
 *   yaInsistio  si ya se gastó el reintento con el mismo modelo
 *   hayEscalon  si hay algún modelo instalado más liviano que este
 * @returns {{que:'insistir'|'bajar'|'rendirse', esperaMs:number}}
 */
function queHacer(paso) {
    const p = paso || {};

    // Nada corrió: no hay hipótesis que probar, y ningún modelo arregla que falte
    // el binario. Se rinde acá para no gastar la fila en tres intentos idénticos.
    if (!p.muerte) return { que: 'rendirse', esperaMs: 0 };

    if (p.muerte === 'senal' && p.conElBueno && !p.yaInsistio) {
        return { que: 'insistir', esperaMs: ESPERA_MS };
    }
    if (p.hayEscalon) return { que: 'bajar', esperaMs: 0 };
    return { que: 'rendirse', esperaMs: 0 };
}

/* ─── Cómo queda marcada la toma ──────────────────────────────────────────
 *
 * Las dos marcas viven en `toma.relectura` y van al sidecar como todo lo que se
 * mide de una toma, o sea que sobreviven a cerrar la app. **Eso es el punto**: la
 * toma que se leyó con un modelo peor es exactamente la que alguien va a querer
 * regenerar con calma, y si la marca solo viviera en memoria se perdería al
 * apagar — justo la información que hace falta al día siguiente.
 *
 * Que no haya marca es que la toma salió bien con el modelo bueno, que es lo que
 * pasa siempre. Es la misma convención que ya usan el empalme y las medidas del
 * panel: sin estado, la tarjeta no dibuja nada (ver `borrar` en `medir-toma.js`).
 *
 * Los dos estados se llaman como los que ya existen en las tarjetas —`midiendo`,
 * `falla`, `sin-modelo`, `abstenido`— y no inventan otra forma de decir lo mismo:
 * un participio para lo que se hizo y un privativo para lo que falta.
 *
 * El texto va armado desde acá y no desde la pantalla, por lo mismo que
 * `gpu.PORQUE`: es UNA explicación, la escribe quien sabe lo que pasó, y la
 * tarjeta de la clase en curso y la de la clase terminada no pueden contarla de
 * dos maneras distintas.
 */

/**
 * `degradada` — se leyó, pero con un modelo peor que el que correspondía.
 *
 * Dice las tres cosas que hacen falta para decidir qué hacer con ella: qué pasó,
 * con qué se leyó al final, y con qué se la quería leer. Sin la última, "se leyó
 * con base" no se puede comparar contra nada.
 */
function degradada(params) {
    const p = params || {};
    return {
        estado: 'degradada',
        modelo: p.modelo || null,
        bueno: p.bueno || null,
        porque: `Esta toma se releyó con ${p.modelo}, que es más liviano que ` +
            `${p.bueno}: el sistema le cortó a whisper-cli las pasadas con el modelo bueno. ` +
            'El texto es peor que el del resto de la clase. "Regenerar" la vuelve a leer ' +
            `con ${p.bueno}, con la máquina libre.`,
        detalle: p.detalle || ''
    };
}

/**
 * `sin-leer` — no se pudo con ninguno, incluido el más chico.
 *
 * **Acá el silencio es exactamente lo que hay que evitar**, así que la toma
 * conserva el texto que tenga —el del ciclo de señales, que es malo pero no es
 * nada— y la marca dice las dos cosas que nadie puede adivinar mirándolo: que ese
 * texto no es el bueno, y que hay un botón que lo arregla. Sin esto, una toma sin
 * releer se lee igual que una releída y nadie va a apretar nada.
 */
function sinLeer(params) {
    const p = params || {};
    return {
        estado: 'sin-leer',
        modelo: null,
        bueno: p.bueno || null,
        porque: 'A esta toma no se le pudo rehacer el texto: se intentó con ' +
            `${p.bueno}${p.hastaDonde ? ` y con ${p.hastaDonde}` : ' y no había ningún modelo más liviano al que bajar'}. ` +
            'Lo que se ve es el texto del ciclo de señales, que es el descartable. ' +
            '"Regenerar" la vuelve a leer con la máquina libre.',
        detalle: p.detalle || ''
    };
}

module.exports = {
    CICLO_MS,
    PASADA_MS,
    ESPERA_MS,
    comoSeMurio,
    queHacer,
    degradada,
    sinLeer
};
