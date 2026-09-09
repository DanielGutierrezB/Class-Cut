'use strict';
/**
 * ipc/grabar.js — El puente de la toma de notas en vivo.
 *
 * La grabación vive del lado de Node y no de la ventana, aunque la ventana sea la
 * que dibuja: hay una sola verdad, y es la que escribe el XML. La ventana manda
 * el audio y los cambios que hace el editor, y recibe el estado entero de vuelta
 * (`engine/grabacion.js`).
 *
 * Está en su archivo y no en `main.js` porque de él necesita dos cosas —mandar
 * avisos a la ventana y anotar en el diario— y `main.js` ya junta cuarenta
 * canales. El puente de cada parte nueva va aparte; este es el primero.
 */

const grabacion = require('../engine/grabacion');
const vivo = require('../engine/notas-vivo');

/**
 * @param {object} deps { ipcMain, app, send, anotar } de `main.js`
 */
function registrar({ ipcMain, app, send, anotar }) {
    ipcMain.handle('grabar-iniciar', (event, payload) => {
        const p = payload || {};
        try {
            const estado = grabacion.iniciar({
                ...p,
                avisar: aviso => send('grabar-aviso', aviso)
            });
            anotar('grabar.inicia', {
                secuencia: estado.secuencia, dir: estado.dir, dispositivo: p.dispositivo
            });
            return { ok: true, estado };
        } catch (err) {
            anotar('grabar.no-arranca', { error: err.message });
            return { ok: false, error: err.message };
        }
    });

    /**
     * El PCM que manda la ventana. Va por `on` y no por `handle`: llega varias
     * veces por segundo y no hay nada que esperar de vuelta, y devolver el estado
     * entero cada vez llenaría el puente de tomas repetidas.
     */
    ipcMain.on('grabar-pcm', (event, chunk) => {
        try {
            grabacion.pcm(chunk);
        } catch (err) {
            anotar('grabar.pcm-falla', { error: err.message });
        }
    });

    // "La claqueta es ahora": la puso el editor, así que queda confirmada.
    ipcMain.handle('grabar-claqueta', (event, paredMs) => {
        anotar('grabar.claqueta', { ms: paredMs, aMano: true });
        return grabacion.claqueta(paredMs);
    });

    /**
     * La lista de temas que el CD pidió, pegada en el panel de análisis.
     *
     * Llega el texto crudo y no los objetivos ya partidos: partirlo es una
     * decisión —qué es una viñeta, qué es un encabezado— y tiene que ser la misma
     * la primera vez y cuando la clase se relea del sidecar. Con la pantalla
     * partiendo, dos versiones de la app leerían la misma lista distinto.
     *
     * Devuelve el estado entero, como todo lo demás de este puente: la medición
     * tarda unos segundos y llega después, por `grabar-aviso`.
     */
    ipcMain.handle('grabar-temario', (event, texto) => {
        const estado = grabacion.ponerTemario(texto);
        anotar('grabar.temario', {
            objetivos: estado && estado.temario ? estado.temario.objetivos.length : 0
        });
        return estado;
    });

    ipcMain.handle('grabar-editar', (event, cambio) => {
        anotar('grabar.editar', { toma: cambio && cambio.toma, tipo: cambio && cambio.tipo });
        return grabacion.editar(cambio);
    });

    ipcMain.handle('grabar-cerrar-toma', () => grabacion.cerrarToma());

    /**
     * Deshacer y rehacer lo que el editor hizo a mano.
     *
     * Contestan `{ok, que, error, estado}` y no el estado pelado como los demás
     * canales de acá, porque hay dos cosas que la ventana no puede saber sola:
     * qué paso se acaba de revertir —lo dice en el aviso, que si no un cambio
     * revertido lejos del scroll es invisible— y por qué un paso no se pudo
     * revertir (una toma nueva abierta encima, ver `engine/deshacer.js`).
     */
    ipcMain.handle('grabar-deshacer', () => {
        const r = grabacion.deshacer();
        anotar('grabar.deshace', { que: r.que || '', pudo: r.ok });
        return r;
    });

    ipcMain.handle('grabar-rehacer', () => {
        const r = grabacion.rehacer();
        anotar('grabar.rehace', { que: r.que || '', pudo: r.ok });
        return r;
    });
    ipcMain.handle('grabar-estado', () => grabacion.resumen());
    // Las vistas viajan con el estado de la grabación en curso, pero una clase ya
    // terminada también deja cambiarlas y ahí no hay estado del que sacarlas.
    ipcMain.handle('grabar-vistas', () => vivo.VISTAS);
    ipcMain.handle('grabar-listar', (event, dirs) => grabacion.listar(dirs));

    // Tarda lo que tarde releer las últimas tomas con el modelo grande: la
    // ventana espera la respuesta y lo dice mientras tanto.
    ipcMain.handle('grabar-terminar', async () => {
        const salida = await grabacion.terminar();
        anotar('grabar.termina', {
            secuencia: salida && salida.secuencia,
            tomas: salida ? salida.tomas.length : 0
        });
        return salida;
    });

    // Comentar una clase que ya terminó. Reescribe su XML en el acto, así que la
    // respuesta dice si se pudo: la ventana avisa con eso.
    ipcMain.handle('grabar-editar-grabada', (event, json, cambio) => {
        anotar('grabar.editar-grabada', { json, toma: cambio && cambio.toma, tipo: cambio && cambio.tipo });
        try {
            return { ok: true, ...grabacion.editarGrabada(json, cambio) };
        } catch (err) {
            anotar('grabar.editar-grabada-falla', { json, error: err.message });
            return { ok: false, error: err.message };
        }
    });

    /**
     * Renombrar y borrar una clase de la lista.
     *
     * Contestan `{ok, error}` como `grabar-editar-grabada` y no el estado pelado:
     * los dos se pueden negar por un motivo que solo el motor conoce —un número
     * que chocaría con otra clase, una clase que se está grabando ahora mismo— y
     * ese motivo hay que poder mostrarlo tal cual.
     *
     * La confirmación de borrar es de la pantalla y no de acá. Cuando el gesto
     * llega a este renglón ya está decidido, y el motor borra.
     */
    ipcMain.handle('grabar-renombrar', (event, json, cambio) => {
        anotar('grabar.renombrar', { json, clase: cambio && cambio.clase });
        try {
            const r = grabacion.renombrarGrabada(json, cambio);
            anotar('grabar.renombrada', { json, secuencia: r.secuencia, audios: r.audios });
            return { ok: true, ...r };
        } catch (err) {
            anotar('grabar.renombrar-falla', { json, error: err.message });
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('grabar-borrar', (event, json) => {
        anotar('grabar.borrar', { json });
        try {
            const r = grabacion.borrarGrabada(json);
            anotar('grabar.borrada', { json, secuencia: r.secuencia, audios: r.audios });
            return { ok: true, ...r };
        } catch (err) {
            anotar('grabar.borrar-falla', { json, error: err.message });
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('grabar-regenerar', async (event, json) => {
        anotar('grabar.regenerar', { json });
        try {
            const r = await grabacion.regenerar(json, aviso => send('grabar-aviso', aviso));
            anotar('grabar.regenerada', { json, tomas: r.tomas, sinAudio: r.sinAudio });
            return { ok: true, ...r };
        } catch (err) {
            anotar('grabar.regenerar-falla', { json, error: err.message });
            return { ok: false, error: err.message };
        }
    });

    // Si había una grabación en curso al cerrar la app, se termina: la cabecera
    // del WAV queda con el tamaño real y el XML con lo último que pasó. Cerrar la
    // app en medio de un rodaje no puede costar la clase.
    app.on('before-quit', () => {
        try { grabacion.apagar(); } catch (e) { /* ya estaba cerrado */ }
    });
}

module.exports = { registrar };
