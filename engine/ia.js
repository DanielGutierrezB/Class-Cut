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
const claves = require('./claves');
const ollamaServer = require('./ollama-server');
const cursor = require('./ai-cursor');
const anthropic = require('./ai-anthropic');
const registro = require('./registro');

/**
 * El mismo cliente, pero anotando cada consulta en el diario.
 *
 * Las llamadas al criterio son de lejos lo que más se rompe: el modelo local se
 * queda sin memoria, la API contesta 429, el Cursor CLI se cuelga esperando. Y
 * hasta acá no dejaban ningún rastro — el diario contaba que la clase falló, sin
 * decir en cuál de las veinte consultas ni por qué.
 *
 * Se envuelve acá y no en cada proveedor porque los tres exponen el mismo `ask`:
 * un solo lugar, y ninguno se puede olvidar de anotar.
 *
 * **No se anota ni el prompt ni la respuesta.** El prompt lleva el transcript de
 * la clase, que es lo que se dijo en un aula; ese archivo se manda por mail para
 * pedir ayuda. Los tamaños y los tiempos alcanzan para diagnosticar: una consulta
 * de 900k caracteres que tarda 90 segundos y vuelve con 429 se entiende sin leer
 * una palabra de lo que decía.
 */
function conDiario(cliente, proveedor) {
    if (!cliente || typeof cliente.ask !== 'function') return cliente;
    const original = cliente.ask.bind(cliente);
    let cuantas = 0;
    return {
        ...cliente,
        ask: async params => {
            const numero = ++cuantas;
            const arranco = Date.now();
            const pedido = {
                n: numero,
                proveedor,
                model: cliente.model,
                prompt: (params && params.prompt ? params.prompt.length : 0),
                system: (params && params.system ? params.system.length : 0)
            };
            try {
                const r = await original(params);
                const tardo = Date.now() - arranco;
                // Un `error` adentro de la respuesta es la manera normal en que
                // estos clientes cuentan que no pudieron: no tiran.
                if (r && r.error) registro.anotar('main', 'ia.falla', { ...pedido, ms: tardo, error: r.error });
                else registro.anotar('main', 'ia.consulta', { ...pedido, ms: tardo });
                return r;
            } catch (err) {
                registro.anotar('main', 'ia.falla', {
                    ...pedido, ms: Date.now() - arranco, error: err && err.message
                });
                throw err;
            }
        }
    };
}

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
    const armado = await elegirProveedor(opciones, config);
    // Envolver acá y no en cada rama: las tres devuelven por su lado y una rama
    // nueva se olvidaría de anotar sin que nada lo delate.
    return { ...armado, cliente: conDiario(armado.cliente, armado.proveedor) };
}

/** Las tres ramas, sin el diario. Lo de afuera usa `armar`. */
async function elegirProveedor(opciones, config) {
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
            // La clave vive en el Llavero, nunca en los ajustes guardados
            // (`sanear` la descarta al escribir). Una config EN MEMORIA sí puede
            // traer el campo —los tests y los A/B de medición—, y si el campo
            // ESTÁ, manda aunque venga vacío: es la única manera de que una
            // prueba diga "sin clave" sin depender del Llavero de la máquina.
            const apiKey = 'apiKey' in ia.anthropic ? ia.anthropic.apiKey : claves.leer('anthropic');
            if (!apiKey) {
                return {
                    cliente: null, proveedor: 'anthropic',
                    reason: 'Ajustes pide la API de Claude y no hay clave: iniciá sesión o pegá una en Ajustes.'
                };
            }
            return {
                cliente: anthropic.cliente({ model, apiKey }),
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
            if (!claves.leer('anthropic')) {
                return {
                    estado: 'falta', model: ia.anthropic.modelo, proveedor: 'anthropic',
                    reason: 'Ajustes pide la API de Claude y no hay clave guardada.'
                };
            }
            return {
                estado: 'listo', model: ia.anthropic.modelo, proveedor: 'anthropic',
                source: 'API de Anthropic',
                reason: `${nombreDe('anthropic', ia.anthropic.modelo)}. La clave está en el Llavero.`
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
            // Probar con la clave recién pegada si vino; si no, con la del
            // Llavero — que es lo que va a usar la corrida de verdad.
            return anthropic.probar({
                model: config.modelo,
                apiKey: config.apiKey || claves.leer('anthropic')
            });
        default: {
            const nunca = config.proveedor;
            return { ok: false, reason: `Proveedor desconocido: ${nunca}.` };
        }
    }
}

/**
 * Corre tareas de a `limite` a la vez, conservando el orden de los resultados.
 *
 * Existe por los proveedores remotos: con el modelo local las consultas van en
 * fila porque compiten por la MISMA máquina —paralelizarlas es hacer cola en el
 * GPU con más pasos—, pero contra una API cada consulta es un viaje de red y
 * esperarlas de a una es tirar el tiempo de todas menos una. El límite evita lo
 * contrario: cuarenta consultas juntas es pedirle al proveedor que nos limite.
 *
 * @param {number} limite cuántas a la vez (1 = en fila, como siempre)
 * @param {Array} items
 * @param {(item, indice) => Promise} tarea
 * @returns {Promise<Array>} resultados en el orden de `items`
 */
async function enTandas(limite, items, tarea) {
    const lista = [...items];
    const resultados = new Array(lista.length);
    const ancho = Math.max(1, Math.min(limite || 1, lista.length));
    let proximo = 0;

    async function obrero() {
        while (proximo < lista.length) {
            const indice = proximo++;
            resultados[indice] = await tarea(lista[indice], indice);
        }
    }

    await Promise.all(Array.from({ length: ancho }, obrero));
    return resultados;
}

/** Apaga lo que haya que apagar. Solo el local levanta procesos. */
function parar() {
    ollamaServer.stop();
}

module.exports = { armar, estado, probar, parar, nombreDe, enTandas };
