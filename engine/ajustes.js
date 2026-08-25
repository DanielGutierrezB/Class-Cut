'use strict';
/**
 * ajustes.js — Las preferencias del editor, guardadas fuera del proyecto.
 *
 * Viven en `~/Library/Application Support/Class Cut/ajustes.json`, no junto a
 * un curso: qué proveedor de IA usar es una decisión de la máquina y del
 * editor, no de la clase que se esté cortando. Y no en el localStorage de la
 * ventana, porque las herramientas de línea de comandos (`tools/medir-*.js`)
 * tienen que cortar con EXACTAMENTE el mismo criterio que la app — medir con
 * otro proveedor del que se usa sería medir otro producto.
 *
 * La escritura es atómica (archivo temporal + rename): un cierre a mitad de
 * guardado no puede dejar el JSON por la mitad.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Los proveedores que existen. El orden es el de la página de Ajustes. */
const PROVEEDORES = ['local', 'cursor', 'anthropic'];

const DEFAULTS = {
    version: 1,
    ia: {
        // 'local' es el que funciona en una Mac recién sacada de la caja, sin
        // cuentas ni claves: el que viene con la app.
        proveedor: 'local',
        // La configuración de cada proveedor se conserva aunque no esté activo:
        // cambiar a Claude y volver no puede hacerte reescribir el modelo que
        // tenías elegido en el otro.
        local: { modelo: null },
        cursor: { modelo: 'claude-sonnet-5-thinking-high' },
        anthropic: { modelo: 'claude-sonnet-4-5', apiKey: '' }
    }
};

function archivo() {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Class Cut', 'ajustes.json');
}

/** Un objeto con TODAS las claves, venga lo que venga del disco. */
function sanear(crudo) {
    const ia = (crudo && crudo.ia) || {};
    return {
        version: DEFAULTS.version,
        ia: {
            proveedor: PROVEEDORES.includes(ia.proveedor) ? ia.proveedor : DEFAULTS.ia.proveedor,
            local: { modelo: (ia.local && ia.local.modelo) || null },
            cursor: { modelo: (ia.cursor && ia.cursor.modelo) || DEFAULTS.ia.cursor.modelo },
            anthropic: {
                modelo: (ia.anthropic && ia.anthropic.modelo) || DEFAULTS.ia.anthropic.modelo,
                apiKey: (ia.anthropic && typeof ia.anthropic.apiKey === 'string') ? ia.anthropic.apiKey : ''
            }
        }
    };
}

function leer() {
    try {
        return sanear(JSON.parse(fs.readFileSync(archivo(), 'utf8')));
    } catch (err) {
        // Sin archivo o con un archivo roto, la app arranca con lo de fábrica:
        // unos ajustes ilegibles no pueden dejar sin cortar.
        return sanear(null);
    }
}

function guardar(datos) {
    const limpio = sanear(datos);
    const destino = archivo();
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const temporal = `${destino}.tmp-${process.pid}`;
    fs.writeFileSync(temporal, `${JSON.stringify(limpio, null, 2)}\n`);
    fs.renameSync(temporal, destino);
    return limpio;
}

module.exports = { leer, guardar, sanear, archivo, PROVEEDORES, DEFAULTS };
