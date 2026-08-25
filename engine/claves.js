'use strict';
/**
 * claves.js — Los secretos, en el Llavero de macOS y en ningún otro lado.
 *
 * Una clave de API en un JSON es un secreto guardado en texto plano: viaja en
 * cada backup, se lee con `cat` y aparece en cualquier pantalla compartida
 * donde se abra el archivo. El Llavero existe exactamente para esto — cifrado
 * con la sesión del usuario, y `security(1)` viene en toda Mac.
 *
 * La ventana nunca ve estos valores: el proceso principal los lee cuando arma
 * el cliente, y a la interfaz solo le llega "hay una clave guardada" (sí/no).
 */

const { execFileSync } = require('child_process');

const SERVICIO = 'Class Cut';
const SECURITY = '/usr/bin/security';

/**
 * @param {string} cuenta p. ej. 'anthropic'
 * @returns {string|null} el secreto, o null si no hay
 */
function leer(cuenta) {
    try {
        return execFileSync(SECURITY,
            ['find-generic-password', '-s', SERVICIO, '-a', cuenta, '-w'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim() || null;
    } catch (err) {
        // No estar no es un error: es la respuesta.
        return null;
    }
}

/** Guarda (o reemplaza: `-U`) el secreto de una cuenta. */
function guardar(cuenta, secreto) {
    execFileSync(SECURITY,
        ['add-generic-password', '-U', '-s', SERVICIO, '-a', cuenta, '-w', String(secreto)],
        { stdio: ['ignore', 'ignore', 'pipe'] });
}

function borrar(cuenta) {
    try {
        execFileSync(SECURITY,
            ['delete-generic-password', '-s', SERVICIO, '-a', cuenta],
            { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (err) {
        // Borrar lo que no está deja el mismo estado que borrarlo.
    }
}

module.exports = { leer, guardar, borrar, SERVICIO };
