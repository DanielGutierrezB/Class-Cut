'use strict';
/**
 * temario-sesion.js — El temario del CD mientras se graba.
 *
 * El director de contenido entrega una lista de temas que la clase tiene que
 * cubrir. Se pega en el panel de análisis y desde ahí se mide, mientras se
 * graba, contra lo que el profesor ya dijo. Lo que decide y lo que valida vive
 * en `engine/temario.js`, que no toca disco ni red; acá está lo que solo la
 * sesión puede tener: cuándo se dispara, contra qué tomas y dónde se guarda.
 *
 * Salió de `grabacion.js` con esa frontera ya dibujada —era el bloque bajo el
 * título "El temario del CD y su cobertura"— y la mudanza no la movió: todo lo
 * de acá recibe la sesión y no sabe nada del ciclo de señales ni de la cola de
 * relecturas, que son los que lo llaman.
 */

const fs = require('fs');
const path = require('path');

const espejo = require('./espejo');
const clasesGrabadas = require('./clases-grabadas');
const temario = require('./temario');
const medirToma = require('./medir-toma');
const gpu = require('./gpu');
const workspace = require('./workspace');
const ia = require('./ia');

/**
 * Una lista recién partida, sin nada medido. Los cuatro campos van siempre: el
 * panel los lee sin preguntar si existen, y `undefined` ahí se dibuja igual que
 * un fallo que nadie tuvo.
 */
function sinMedir(texto, objetivos, origen) {
    return { texto: String(texto == null ? '' : texto), objetivos, origen, cobertura: null, fallo: null, abstenido: null };
}

/* ─── La lista del curso, en la carpeta ──────────────────────────────────── */

/**
 * Dónde queda la lista del CD: en la carpeta de notas, con lo demás que la app
 * se guarda para sí misma (`Datos/`, ver `workspace.js`).
 *
 * **Vive en la carpeta y no en los ajustes**, y eso es lo mismo que decidió
 * `heredar` antes que esto: la carpeta ES el curso, así que la lista del curso no
 * puede quedar en una preferencia global que otro curso se lleve puesta. Y no
 * vive en la sesión porque el momento de pegarla es ANTES de grabar —la lista
 * llega por mail el día anterior— y ahí no hay ninguna sesión que la aguante.
 *
 * Se guarda el texto crudo y nada más. Los objetivos se vuelven a partir en cada
 * lectura para que una app más nueva parta mejor lo mismo que ya estaba guardado,
 * y para que no haya dos versiones de la misma lista en el mismo archivo.
 */
function archivoDelCurso(dir) {
    return path.join(workspace.notasDatosDir(dir), 'temario.json');
}

/**
 * La lista guardada para esa carpeta, o null.
 *
 * @param {string} dir la carpeta de notas del curso
 */
function leerDelCurso(dir) {
    if (!dir) return null;
    const guardado = workspace.readJson(archivoDelCurso(dir));
    if (!guardado) return null;
    const objetivos = temario.partir(guardado.texto);
    return objetivos.length ? sinMedir(guardado.texto, objetivos, 'guardado') : null;
}

/**
 * Guarda la lista del curso, o la saca si lo pegado quedó vacío.
 *
 * Borrar el archivo y no dejarlo con la lista vacía: lo que se lee después es
 * "no hay lista para este curso", y esas dos formas de decirlo se contestan
 * distinto en cuanto alguien se olvide de mirar una de las dos.
 *
 * @returns {object|null} la lista tal como queda guardada
 */
function guardarEnElCurso(dir, texto) {
    if (!dir) return null;
    const objetivos = temario.partir(texto);
    const archivo = archivoDelCurso(dir);
    if (!objetivos.length) {
        try { fs.unlinkSync(archivo); } catch (e) { /* si no estaba, ya está sacada */ }
        return null;
    }
    workspace.writeJson(archivo, { texto: String(texto), guardadoMs: Date.now() });
    return sinMedir(texto, objetivos, 'guardado');
}

/**
 * La lista que se pega con la clase todavía sin empezar.
 *
 * Es el camino que el panel usa antes de "Iniciar grabación", que es cuando el
 * editor tiene la lista del CD en la mano y todavía no comprometió ningún
 * archivo. No mide nada —no hay ni una toma contra la que medir— y no falta: la
 * sesión que arranque después se la encuentra puesta por `heredar`.
 */
function ponerEnElCurso(dir, texto) {
    const puesta = guardarEnElCurso(dir, texto);
    // Y vuelve como 'pegado', que es lo único que la distingue de la misma lista
    // leída mañana: el rótulo del panel existe para avisar que una lista apareció
    // sola —"guardada para esta carpeta"— y la que se acaba de pegar no apareció
    // sola, la pegó quien está mirando. Al reabrir la app sí llegó sola, y ahí
    // `leerDelCurso` la marca 'guardado'.
    return puesta && { ...puesta, origen: 'pegado' };
}

/**
 * Con qué temario nace una sesión.
 *
 * El CD entrega UNA lista para el día o para el curso, no una por clase, y en un
 * día de rodaje se graban cuatro o cinco seguidas. Obligar a pegarla de nuevo en
 * cada una es garantizar que a la tercera nadie la pegue y la validación quede
 * apagada justo cuando ya se confiaba en ella.
 *
 * Primero la guardada en la carpeta, que es la que alguien pegó a propósito para
 * este curso; detrás, la de la clase anterior leída de su sidecar, que es de
 * dónde salía esto antes de que la lista tuviera archivo propio y sigue siendo la
 * única que tienen las carpetas grabadas hasta ayer.
 *
 * Se hereda la lista, NO la cobertura: lo medido es de la clase que se midió. Y
 * el origen viaja con ella porque la pantalla lo dice: una lista que apareció
 * sola no la pegó nadie en ESTA clase, y puede no ser la de esta clase.
 */
function heredar(dir) {
    return leerDelCurso(dir) || deLaClaseAnterior(dir);
}

function deLaClaseAnterior(dir) {
    const previa = clasesGrabadas.listar([dir])
        .find(c => c.temario && (c.temario.objetivos || []).length);
    if (!previa) return null;
    return sinMedir(previa.temario.texto || '', previa.temario.objetivos, 'heredado');
}

/**
 * El temario que se pegó en la pantalla. Texto crudo: partirlo es de `temario.js`.
 *
 * Pegar una lista vacía es querer sacarla, y saca también la medición: dejar la
 * cobertura de una lista que ya no existe sería mostrar un resultado sin su vara.
 *
 * Pegar la MISMA lista otra vez, en cambio, no es pegar otra, y se planta antes
 * de tocar nada. Sin eso el gesto tiraba la cobertura ya medida y pagaba una
 * consulta nueva para llegar al mismo resultado —lo mismo que le pasa a quien
 * pega dos veces por las dudas—, y de paso dejaba en el historial un paso que al
 * deshacerse no se ve, porque el objeto era nuevo aunque dijera lo mismo.
 *
 * La misma lista que llegó sola —la guardada del curso, la de la clase anterior—
 * pegada a mano tampoco tira nada: se le cambia el origen y se queda con lo
 * medido. Confirmar que la lista heredada es la de esta clase es un gesto que
 * vale la pena poder hacer, y hacerlo no puede costar la cobertura ya medida.
 *
 * Y lo pegado queda además guardado para el curso: la lista es del curso y no de
 * esta clase, así que la siguiente la encuentra puesta (ver `heredar`).
 */
function poner(sesion, texto) {
    if (!sesion) return null;
    const objetivos = temario.partir(texto);
    const ya = sesion.estado.temario;
    const mismo = Boolean(ya && ya.texto === String(texto || '') && objetivos.length);
    if (mismo && ya.origen === 'pegado') return espejo.resumen(sesion);

    sesion.estado.temario = !objetivos.length ? null
        : mismo ? { ...ya, origen: 'pegado' }
            : sinMedir(texto, objetivos, 'pegado');
    guardarEnElCurso(sesion.dir, texto);
    espejo.escribir(sesion);
    // Contra lo que ya haya grabado, sin esperar la toma siguiente: la lista se
    // pega con la clase empezada y el panel tiene que decir algo en el acto.
    pedir(sesion);
    return espejo.resumen(sesion);
}

/**
 * Larga la medición si hace falta, y una sola a la vez.
 *
 * La promesa vive en la sesión —igual que `rehaciendo`— y no un booleano: así
 * `terminar` podría esperarla, y sobre todo así se sabe que hay una en vuelo sin
 * tener que acordarse de bajar una bandera en cada salida.
 */
function pedir(sesion) {
    if (!sesion || !sesion.viva || sesion.midiendoTemario) return;
    const t = sesion.estado.temario;
    // Con la cobertura de la mano: sin ella la huella nunca coincide con la de lo
    // ya medido, y una clase con proveedor andando se pasaba la hora midiendo lo
    // mismo una y otra vez —el bucle de `atender` no encontraba salida—.
    if (!t || !temario.hayQueMedir({
        objetivos: t.objetivos,
        tomas: sesion.estado.tomas,
        cobertura: t.cobertura
    })) return;
    sesion.midiendoTemario = atender(sesion)
        .finally(() => { if (sesion.viva) sesion.midiendoTemario = null; });
}

/**
 * Mide, y vuelve a mirar si mientras se medía apareció material nuevo.
 *
 * El bucle es lo que resuelve las llamadas encimadas sin encolar nada: una
 * consulta tarda unos segundos y en ese rato puede cerrarse otra toma. Con una
 * cola habría que decidir qué hacer con dos pedidos que piden lo mismo; acá se
 * vuelve a preguntar por la huella, y si se movió se mide una vez con TODO lo
 * que hay, que es una consulta en vez de dos y con la respuesta más completa.
 *
 * El proveedor se arma en cada pasada y no una vez por sesión: el editor puede
 * cambiarlo en Ajustes en medio de un rodaje, y `ia.armar` no falla nunca —sin
 * proveedor utilizable devuelve `cliente: null` y el motivo, que es justo lo que
 * hay que mostrar—.
 */
async function atender(sesion) {
    while (sesion.viva && sesion.estado.temario) {
        const t = sesion.estado.temario;
        if (!temario.hayQueMedir({
            objetivos: t.objetivos,
            tomas: sesion.estado.tomas,
            cobertura: t.cobertura
        })) return;

        // Con el modelo local no se consulta mientras se graba: le pelearía la
        // GPU al Whisper de las señales, que es de donde salen las tomas. El
        // criterio entero y su porqué están en `engine/gpu.js`; acá se anota la
        // deuda y se corta, y se paga al cerrar la sesión (`alCerrar`).
        //
        // Se corta el bucle por lo mismo que lo corta un fallo: no se midió, así
        // que la huella no se movió y `hayQueMedir` volvería a decir que sí para
        // siempre. Se vuelve a intentar cuando cierre la toma que viene.
        if (!gpu.sePuedeConsultar()) {
            if (t.abstenido === gpu.PORQUE) return;
            t.abstenido = gpu.PORQUE;
            espejo.fijar(sesion);
            return;
        }

        let medida;
        try {
            const criterio = await ia.armar({});
            if (!sesion.viva) return;
            medida = await temario.medir({
                objetivos: t.objetivos,
                tomas: sesion.estado.tomas,
                ai: criterio.cliente
            });
            if (!medida.cobertura && !criterio.cliente) medida.error = criterio.reason;
        } catch (err) {
            // Que no se pueda medir la cobertura no puede llevarse por delante la
            // grabación: se anota el motivo y la clase sigue.
            medida = { error: err.message };
        }
        if (!sesion.viva) return;

        // La cobertura buena reemplaza a la anterior; el fallo se guarda al lado y
        // no en su lugar, así una consulta que se cayó no borra lo último medido.
        if (medida.cobertura) t.cobertura = medida.cobertura;
        t.fallo = medida.error || null;
        t.abstenido = null;

        espejo.fijar(sesion);

        // **Un fallo corta el bucle.** Sin esto la huella se queda quieta —nadie
        // la movió, porque no hubo medición— y `hayQueMedir` sigue diciendo que
        // sí: un proveedor caído se convertía en consultas en fila hasta que
        // terminara la clase. Se vuelve a intentar cuando cierre la toma
        // siguiente, que es el único momento en que la respuesta puede cambiar.
        if (!medida.cobertura) return;
    }
}

/**
 * La cobertura que se había abstenido, ya sin Whisper delante.
 *
 * **Es el latido de siempre y no un mecanismo aparte**: `pedir` con su huella
 * decidiendo si hace falta medir, igual que en el cierre de cada toma. Lo único
 * que cambió es que el veto ya no aplica, así que esta pasada sí consulta. Si la
 * clase se midió en vivo —proveedor remoto— la huella no se movió y esto no
 * cuesta nada.
 *
 * Se espera con techo por lo mismo que `medirToma.cerrar`: el editor apretó
 * "Terminar" porque quiere el XML en la mano, y lo que no llegue queda dicho.
 */
async function alCerrar(sesion) {
    pedir(sesion);
    if (!sesion.viva || !sesion.midiendoTemario) return;
    await medirToma.conTecho(sesion.midiendoTemario, medirToma.CIERRE_MS);
}

module.exports = { heredar, leerDelCurso, ponerEnElCurso, poner, pedir, alCerrar };
