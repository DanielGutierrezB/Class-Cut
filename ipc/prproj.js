'use strict';
/**
 * ipc/prproj.js — El puente del proyecto de Premiere.
 *
 * Aparte de `ipc/grabar.js` aunque el botón viva en la misma pestaña, porque no
 * es lo mismo: la toma de notas escribe una clase mientras alguien habla, y esto
 * lee un curso ya cortado y lo empaqueta. Comparten la pantalla y nada más.
 *
 * Lo que sale de acá es ADITIVO. El XML sigue siendo la entrega, y si generar el
 * proyecto falla no puede llevarse puesto nada de lo que ya funciona: por eso
 * cada canal contesta `{ ok }` en vez de tirar, y el motor escribe el archivo
 * nuevo sin tocar ninguno de los que ya estaban.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ajustes = require('../engine/ajustes');
const curso = require('../engine/prproj-curso');

/**
 * Dónde cae el proyecto de un curso.
 *
 * El nombre es el de la carpeta, que es como el editor llama al curso en todos
 * lados: si la carpeta es `2026_curso-spec-driven-development`, el proyecto se
 * llama igual. Un nombre inventado por nosotros obligaría a traducir entre lo que
 * dice el Finder y lo que dice Premiere cada vez.
 *
 * Y va en una carpeta `Proyecto/` propia, no suelto: Premiere deja auto-guardados
 * y previsualizaciones al lado del proyecto, y sin una carpeta que los contenga
 * eso se mezcla con el material.
 */
function destinoDe(carpeta) {
    return path.join(carpeta, 'Proyecto', `${path.basename(carpeta)}.prproj`);
}

/**
 * El primer nombre libre al lado de uno ocupado: `Curso 2.prproj`, `Curso 3`…
 *
 * Se cuenta hasta encontrar hueco en vez de pegarle la fecha porque así se lee
 * como lo que es —el segundo intento, el tercero— y es lo que hace el Finder, que
 * es donde el editor los va a ver.
 */
function alLado(destino) {
    const dir = path.dirname(destino);
    const ext = path.extname(destino);
    const base = path.basename(destino, ext);
    for (let n = 2; n < 1000; n++) {
        const otro = path.join(dir, `${base} ${n}${ext}`);
        if (!fs.existsSync(otro)) return otro;
    }
    // Mil proyectos del mismo curso es un problema que no vamos a resolver
    // inventando un nombre más largo.
    throw new Error(`Hay demasiados proyectos en ${dir}. Llevate alguno antes de generar otro.`);
}

/**
 * Por qué este archivo no sirve de plantilla, o `null` si sirve.
 *
 * Se revisa al elegirla y no al usarla, y esa es toda la gracia: enterarse de que
 * el archivo no servía recién cuando se quiso armar el curso entero es enterarse
 * tarde y en el peor momento. Acá el error todavía tiene un arreglo obvio, que es
 * elegir otro.
 *
 * La revisión es la mínima que distingue un proyecto de Premiere de cualquier
 * otra cosa con esa extensión: que descomprima y que adentro esté el nodo raíz.
 * Más que eso sería adivinar qué va a poder clonar el motor, y de eso sabe él.
 */
function porQueNoSirve(ruta) {
    let crudo = null;
    try {
        crudo = zlib.gunzipSync(fs.readFileSync(ruta));
    } catch (err) {
        return 'Ese archivo no se pudo abrir. Un .prproj es XML comprimido, ' +
            'y este no lo es: ¿está dañado, o es un proyecto de otro programa?';
    }
    if (!crudo.slice(0, 400).includes('<PremiereData')) {
        return 'Ese archivo se abre pero no es un proyecto de Premiere.';
    }
    return null;
}

/**
 * Qué le pasa hoy a la plantilla, que es lo que decide si el botón se puede
 * apretar y, si no, qué hay que decirle a quien lo mira.
 *
 * Se pregunta al disco en vez de confiar en el ajuste porque una plantilla es un
 * archivo que alguien puede mover, renombrar o tener en un disco externo. El
 * ajuste guarda dónde estaba, no que siga estando.
 */
function estadoDeLaPlantilla() {
    const ruta = ajustes.leer().plantillaPrproj;
    if (!ruta) return { ok: false, falta: 'sin-elegir' };
    try {
        if (!fs.statSync(ruta).isFile()) return { ok: false, falta: 'no-es-archivo', ruta };
    } catch (err) {
        return { ok: false, falta: 'no-esta', ruta };
    }
    return { ok: true, ruta };
}

/**
 * @param {object} deps { ipcMain, dialog, ventana, send, anotar } de `main.js`
 */
function registrar({ ipcMain, dialog, ventana, send, anotar }) {
    ipcMain.handle('prproj-plantilla', () => estadoDeLaPlantilla());

    /**
     * Elegir la plantilla, y comprobarla en el mismo gesto.
     *
     * Se valida antes de guardarla y no al usarla: enterarse de que el archivo
     * no servía recién cuando se quiso generar el curso entero es enterarse
     * tarde y en el peor momento. Acá el error todavía tiene arreglo obvio,
     * que es elegir otro.
     */
    ipcMain.handle('prproj-elegir-plantilla', async () => {
        const elegido = await dialog.showOpenDialog(ventana(), {
            title: 'Elegí un proyecto de Premiere para usar de plantilla',
            buttonLabel: 'Usar de plantilla',
            filters: [{ name: 'Proyecto de Premiere', extensions: ['prproj'] }],
            properties: ['openFile']
        });
        if (elegido.canceled || !elegido.filePaths.length) return { ok: false, cancelado: true };

        const ruta = elegido.filePaths[0];
        const mal = porQueNoSirve(ruta);
        if (mal) {
            anotar('prproj.plantilla-mala', { ruta, error: mal });
            return { ok: false, error: mal };
        }
        const guardados = ajustes.guardar({ ...ajustes.leer(), plantillaPrproj: ruta });
        anotar('prproj.plantilla', { ruta });
        return { ok: true, ruta: guardados.plantillaPrproj };
    });

    ipcMain.handle('prproj-generar', async (event, carpeta) => {
        const plantilla = estadoDeLaPlantilla();
        if (!plantilla.ok) return { ok: false, ...plantilla };

        let destino = destinoDe(carpeta);
        if (fs.existsSync(destino)) {
            // Con el nombre atado a la carpeta, el segundo apretón del botón
            // apunta siempre al mismo archivo. Y ese archivo no es un resultado
            // sino un lugar de trabajo: para cuando alguien vuelva a generar, ahí
            // adentro puede haber una tarde de edición. Reemplazarlo en silencio
            // sería tirar trabajo sin avisar, que es el defecto que menos se
            // perdona.
            const r = await dialog.showMessageBox(ventana(), {
                type: 'warning',
                buttons: ['Guardar uno nuevo al lado', 'Reemplazarlo', 'Cancelar'],
                defaultId: 0,
                cancelId: 2,
                title: 'Ya hay un proyecto de este curso',
                message: 'Ya hay un proyecto de este curso',
                detail: `${destino}\n\nSi lo abriste en Premiere y editaste adentro, ` +
                    'reemplazarlo se lleva puesto ese trabajo.'
            });
            if (r.response === 2) return { ok: false, cancelado: true };
            if (r.response === 0) destino = alLado(destino);
        }

        anotar('prproj.genera', { carpeta, destino, plantilla: plantilla.ruta });
        try {
            const r = await curso.generar({
                carpeta,
                destino,
                plantilla: plantilla.ruta,
                avisar: paso => send('prproj-aviso', { carpeta, ...paso })
            });
            anotar('prproj.generado', { carpeta, ruta: r.ruta, clases: r.clases });
            return { ok: true, ...r };
        } catch (err) {
            anotar('prproj.genera-falla', { carpeta, error: err.message });
            return { ok: false, error: err.message };
        }
    });
}

module.exports = { registrar, estadoDeLaPlantilla, destinoDe, alLado };
