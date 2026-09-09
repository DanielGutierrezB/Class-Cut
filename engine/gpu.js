'use strict';
/**
 * gpu.js — Quién tiene la máquina mientras se graba, y quién se abstiene por eso.
 *
 * Mientras una clase se graba hay un Whisper corriendo cada tres segundos: es el
 * que oye "3, 2, 1" y "Pausa", o sea el que decide dónde arrancan y dónde
 * terminan las tomas. Es lo más importante que está pasando en esta Mac, porque
 * lo que se pierda ahí no se puede volver a grabar: la clase ya pasó.
 *
 * El panel de análisis, al mismo tiempo, le pregunta cosas a un modelo. Con un
 * proveedor remoto —la API de Claude, el Cursor CLI— no hay nada que discutir:
 * la consulta es un viaje de red y el cómputo pasa en otra máquina, así que se
 * mide en vivo y listo. Con el modelo local es la MISMA GPU, los dos tardan el
 * doble, y el que pierde es el Whisper de las señales: la clase que se está
 * grabando se pone en riesgo por medir la clase que se está grabando.
 *
 * **Por eso el criterio es uno solo y vive acá.** Estaba escrito tres veces —en
 * `medir-toma.js`, en `grabacion.regenerar` y en el comentario de `hayQueMedir`
 * de `temario.js`— con tres redacciones, y cada una lo había resuelto a su
 * manera: dos se abstenían y la tercera se conformaba con preguntar menos
 * seguido, así que con un Ollama configurado la cobertura del temario sí le
 * peleaba la GPU al Whisper. Tres redacciones de un mismo criterio son tres
 * criterios en cuanto alguien toca una.
 *
 * **Abstenerse no es no medir: es medir después.** El que se abstiene lo deja
 * anotado y la deuda se paga cuando la grabación termina y esto queda libre
 * (`soltar`, y `cerrar` en `medir-toma.js`). Un panel que se calla para siempre
 * no sería una decisión, sería una pérdida.
 *
 * Sin disco y sin DOM. El único estado es si el Whisper de las señales está
 * andando, y lo mueven `grabacion.iniciar` y `grabacion.terminar`.
 */

const ia = require('./ia');

/**
 * Quién está usando la máquina: `'señales'`, `'cierre'`, o nadie.
 *
 * **Es quién y no un sí o un no, porque las dos preguntas que se hacen acá tienen
 * respuestas distintas.** Con la grabación en curso la tiene el Whisper de las
 * señales; cuando se drena la cola de relecturas la GPU no queda libre sino que
 * cambia de manos, y la agarra la medición del cierre —la que estuvo esperando
 * todo este rato—. En ese momento se PUEDE consultar al modelo local, porque ya
 * no hay ningún Whisper con el que competir, pero NO se puede largar un
 * "Regenerar", que levantaría uno nuevo encima de la medición.
 *
 * Y es un dato propio y no `grabacion.activa()` por lo mismo: la sesión sigue
 * viva durante todo el cierre —la pantalla dice "Terminando…", el XML todavía no
 * se escribió—, así que preguntando por ella la medición abstenida no llegaría a
 * hacerse nunca, que es exactamente lo que hay que evitar.
 */
let quien = null;

/**
 * La agarra alguien. `'señales'` es el Whisper que corre mientras se graba y
 * `'cierre'` la medición que se había abstenido, ya sin Whisper delante.
 */
function tomar(nuevo) {
    quien = nuevo || 'señales';
}

/** Y la suelta. Se puede llamar de más: apagar la app pasa por los dos caminos. */
function soltar() {
    quien = null;
}

/** ¿La está usando alguien? Es lo que le importa a quien vaya a levantar Whisper. */
function ocupada() {
    return quien !== null;
}

/**
 * Lo que queda dicho mientras se está abstenido, y lo que el panel muestra.
 *
 * Se escribe una vez y se lee de acá en los dos bloques: si cada uno redactara
 * el suyo, la próxima corrección se haría en uno solo y el editor vería dos
 * explicaciones distintas de la misma decisión en la misma pantalla.
 *
 * Dice las dos mitades a propósito —por qué no ahora y cuándo sí— porque de eso
 * depende que se lea como una decisión y no como que el bloque está roto.
 */
const PORQUE = 'No se mide en vivo con el modelo local: le pelearía la GPU al Whisper que ' +
    'transcribe la clase y decide dónde arrancan las tomas. Se mide en cuanto termine la grabación.';

/**
 * Con qué proveedor se cortaría ahora, sin levantar nada y sin fallar.
 *
 * `ia.estado()` es la pregunta barata —no lanza servidores ni consulta— y es la
 * misma que ya se hacía en `medir-toma.js`. Si tira, es un bug de otro lado y se
 * va a decir con todas las letras cuando se arme el cliente: no saber cuál es el
 * proveedor no puede convertirse en abstenerse de todo.
 */
function proveedorDeAjustes() {
    try {
        return ia.estado().proveedor;
    } catch (err) {
        return null;
    }
}

/**
 * ¿Se le puede preguntar al modelo ahora, o hay que abstenerse?
 *
 * La abstención es SOLO para el proveedor local, y esa es la mitad del criterio
 * que más fácil se pierde: contra un proveedor remoto no hay ninguna razón para
 * no medir en vivo, y apagarlo "por las dudas" dejaría el panel mudo en la única
 * configuración en la que no cuesta nada.
 *
 * @param {string} [cual] el proveedor, si quien pregunta ya lo sabe. Sin él se
 *   lee de Ajustes; las pruebas y el arnés lo pasan para no depender de la Mac
 *   en la que corran.
 */
function sePuedeConsultar(cual) {
    const proveedor = cual === undefined ? proveedorDeAjustes() : cual;
    return !(proveedor === 'local' && quien === 'señales');
}

module.exports = { tomar, soltar, ocupada, sePuedeConsultar, PORQUE };
