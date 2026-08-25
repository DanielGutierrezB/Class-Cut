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
const claves = require('./claves');

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
        //
        // Acá NO viven secretos: la clave de Anthropic va al Llavero
        // (`engine/claves.js`). Un JSON en Application Support es texto plano
        // que viaja en cada backup.
        local: { modelo: null },
        cursor: { modelo: 'claude-sonnet-5-thinking-high' },
        anthropic: { modelo: 'claude-sonnet-4-5' }
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
            anthropic: { modelo: (ia.anthropic && ia.anthropic.modelo) || DEFAULTS.ia.anthropic.modelo }
        }
    };
}

function leer() {
    let crudo = null;
    try {
        crudo = JSON.parse(fs.readFileSync(archivo(), 'utf8'));
    } catch (err) {
        // Sin archivo o con un archivo roto, la app arranca con lo de fábrica:
        // unos ajustes ilegibles no pueden dejar sin cortar.
    }

    // Migración: las primeras versiones guardaban la clave en este JSON. Se
    // muda al Llavero y el archivo se reescribe sin ella — la próxima lectura
    // ya no pasa por acá.
    const vieja = crudo && crudo.ia && crudo.ia.anthropic && crudo.ia.anthropic.apiKey;
    if (vieja) {
        try {
            claves.guardar('anthropic', vieja);
            guardar(crudo);
        } catch (err) {
            // Si el Llavero no dejó, la clave sigue en el archivo y se vuelve a
            // intentar en la próxima lectura: perderla sería peor que tardar.
        }
    }

    return sanear(crudo);
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
