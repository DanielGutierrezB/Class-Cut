'use strict';
/**
 * ia.js — La puerta del criterio: qué proveedor corre y cómo se arma.
 *
 * El resto del motor no sabe de proveedores: pide un cliente y hace `ask`. Acá
 * se lee la preferencia de Ajustes y se arma el que corresponda:
 *
 * - **local** — el Ollama que trae la app (o el del editor si tiene uno
 *   mejor). Funciona sin internet y sin cuentas; con semilla fija, reprocesar
 *   da el corte idéntico.
 * - **cursor** — el Cursor CLI del editor, con el modelo que elija (Sonnet,
 *   GPT, lo que tenga contratado). Ventana de un millón de tokens: la clase
 *   entera entra de fondo.
 * - **anthropic** — la API de Claude con la clave del editor.
 *
 * Todos devuelven la misma forma que devolvía `ollamaServer.ensure`, así que
 * el pipeline y las herramientas de medición no cambiaron de contrato.
 */

const ajustes = require('./ajustes');
const ollamaServer = require('./ollama-server');
const cursor = require('./ai-cursor');
const anthropic = require('./ai-anthropic');

/** Cómo se lee el proveedor en el cabezal y en los avisos. */
function nombreDe(proveedor, model) {
    switch (proveedor) {
        case 'local': return model ? `${model} (local)` : 'modelo local';
        case 'cursor': return `${model} (Cursor CLI)`;
        case 'anthropic': return `${model} (Claude API)`;
        default: {
            const desconocido = proveedor;
            return `proveedor desconocido: ${desconocido}`;
        }
    }
}

/**
 * Deja el criterio listo y devuelve con qué hablarle.
 *
 * No falla nunca: sin proveedor utilizable devuelve `cliente: null` y el
 * motivo, y quien llama corta con las reglas solas.
 *
 * @param {object} [opciones] { signal, model } — `model` pisa al de Ajustes
 *   (lo usan el selector de la corrida y las herramientas de medición).
 * @param {object} [config] ajustes de IA ya leídos; si no vienen, se leen.
 * @returns {Promise<{cliente:object|null, model?:string, source?:string, reason:string, proveedor:string}>}
 */
async function armar(opciones, config) {
    const ia = config || ajustes.leer().ia;
    const pedido = (opciones && opciones.model) || null;

    switch (ia.proveedor) {
        case 'local': {
            const resultado = await ollamaServer.ensure({
                signal: opciones && opciones.signal,
                model: pedido || ia.local.modelo
            });
            return { ...resultado, proveedor: 'local' };
        }
        case 'cursor': {
            const model = pedido || ia.cursor.modelo;
            if (!cursor.binario()) {
                return {
                    cliente: null, proveedor: 'cursor',
                    reason: 'Ajustes pide el Cursor CLI y no está en esta Mac.'
                };
            }
            return {
                cliente: cursor.cliente({ model }),
                model,
                source: 'Cursor CLI',
                reason: `${model} por el Cursor CLI.`,
                proveedor: 'cursor'
            };
        }
        case 'anthropic': {
            const model = pedido || ia.anthropic.modelo;
            if (!ia.anthropic.apiKey) {
                return {
                    cliente: null, proveedor: 'anthropic',
                    reason: 'Ajustes pide la API de Claude y falta la clave.'
                };
            }
            return {
                cliente: anthropic.cliente({ model, apiKey: ia.anthropic.apiKey }),
                model,
                source: 'API de Anthropic',
                reason: `${model} por la API de Anthropic.`,
                proveedor: 'anthropic'
            };
        }
        default: {
            // `ajustes.sanear` no deja pasar otros valores; llegar acá es un bug.
            const nunca = ia.proveedor;
            throw new Error(`Proveedor de IA sin manejar: ${nunca}`);
        }
    }
}

/**
 * Con qué se cortaría AHORA, para el cabezal y Diagnóstico. Barato: no levanta
 * servidores ni hace consultas.
 *
 * @param {string} [preferido] modelo elegido a mano (solo aplica al local)
 */
function estado(preferido) {
    const ia = ajustes.leer().ia;
    switch (ia.proveedor) {
        case 'local': {
            const propio = ollamaServer.estado(preferido || ia.local.modelo);
            return { ...propio, proveedor: 'local' };
        }
        case 'cursor': {
            if (!cursor.binario()) {
                return {
                    estado: 'falta', model: null, proveedor: 'cursor',
                    reason: 'Ajustes pide el Cursor CLI y no está en esta Mac.'
                };
            }
            return {
                estado: 'listo', model: ia.cursor.modelo, proveedor: 'cursor',
                source: 'Cursor CLI',
                reason: `${nombreDe('cursor', ia.cursor.modelo)}. Cada consulta lanza el CLI.`
            };
        }
        case 'anthropic': {
            if (!ia.anthropic.apiKey) {
                return {
                    estado: 'falta', model: ia.anthropic.modelo, proveedor: 'anthropic',
                    reason: 'Ajustes pide la API de Claude y falta la clave.'
                };
            }
            return {
                estado: 'listo', model: ia.anthropic.modelo, proveedor: 'anthropic',
                source: 'API de Anthropic',
                reason: `${nombreDe('anthropic', ia.anthropic.modelo)}.`
            };
        }
        default: {
            const nunca = ia.proveedor;
            throw new Error(`Proveedor de IA sin manejar: ${nunca}`);
        }
    }
}

/**
 * Prueba una configuración SIN guardarla, para el botón Probar de Ajustes.
 * @param {object} config { proveedor, modelo, apiKey }
 */
async function probar(config) {
    switch (config.proveedor) {
        case 'local': {
            const resultado = await ollamaServer.ensure({ model: config.modelo || null });
            if (!resultado.cliente) return { ok: false, reason: resultado.reason };
            const desde = Date.now();
            const res = await resultado.cliente.ask({
                system: 'Contestás SOLO JSON válido.',
                prompt: 'Contestá exactamente: {"ok": true}',
                numPredict: 30
            });
            if (res.error) return { ok: false, reason: res.error };
            return { ok: true, reason: `${resultado.model} contestó en ${((Date.now() - desde) / 1000).toFixed(1)} s.` };
        }
        case 'cursor':
            return cursor.probar({ model: config.modelo });
        case 'anthropic':
            return anthropic.probar({ model: config.modelo, apiKey: config.apiKey });
        default: {
            const nunca = config.proveedor;
            return { ok: false, reason: `Proveedor desconocido: ${nunca}.` };
        }
    }
}

/** Apaga lo que haya que apagar. Solo el local levanta procesos. */
function parar() {
    ollamaServer.stop();
}

module.exports = { armar, estado, probar, parar, nombreDe };
