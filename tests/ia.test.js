'use strict';
/**
 * Que el criterio se arme con el proveedor que dicen los Ajustes, y que ningún
 * proveedor mal configurado tire una excepción a la corrida: sin clave, sin
 * CLI o sin modelo, la respuesta es `{error}` o `cliente: null` con el motivo,
 * y la clase se corta con las reglas solas.
 *
 * Nada de acá habla con internet ni levanta servidores.
 */

const ajustes = require('../engine/ajustes');
const ia = require('../engine/ia');
const cursor = require('../engine/ai-cursor');
const anthropic = require('../engine/ai-anthropic');

module.exports = function (t) {
    t.group('ajustes · lo que venga del disco queda usable');

    t.test('sin archivo, ni roto, ni a medias: siempre salen completos', () => {
        for (const crudo of [null, {}, { ia: {} }, { ia: { proveedor: 'chatgpt' } }, 'basura']) {
            const limpio = ajustes.sanear(crudo);
            t.eq(limpio.ia.proveedor, 'local', 'el default es el que funciona sin cuentas');
            t.ok(limpio.ia.cursor.modelo, 'el modelo del CLI trae default');
            t.eq(limpio.ia.anthropic.apiKey, '', 'sin clave inventada');
        }
    });

    t.test('la configuración de un proveedor sobrevive aunque no esté activo', () => {
        const limpio = ajustes.sanear({
            ia: {
                proveedor: 'local',
                cursor: { modelo: 'claude-sonnet-5-thinking-high' },
                anthropic: { modelo: 'claude-x', apiKey: 'sk-ant-123' }
            }
        });
        t.eq(limpio.ia.cursor.modelo, 'claude-sonnet-5-thinking-high');
        t.eq(limpio.ia.anthropic.apiKey, 'sk-ant-123');
    });

    t.group('ia · el despachador arma el proveedor pedido');

    t.test('cursor sin CLI y anthropic sin clave avisan, no rompen', async () => {
        // El despachador se prueba con la config inyectada: la de esta Mac no
        // juega, así que da igual qué tenga instalado quien corra la suite.
        const sinClave = ajustes.sanear({ ia: { proveedor: 'anthropic' } }).ia;
        const resultado = await ia.armar({}, sinClave);
        t.eq(resultado.cliente, null);
        t.ok(/clave/i.test(resultado.reason), resultado.reason);
    });

    t.test('anthropic armado con clave devuelve un cliente de ventana grande', async () => {
        const config = ajustes.sanear({
            ia: { proveedor: 'anthropic', anthropic: { modelo: 'claude-x', apiKey: 'sk-ant-fake' } }
        }).ia;
        const resultado = await ia.armar({}, config);
        t.ok(resultado.cliente, 'hay cliente');
        t.eq(resultado.cliente.contextoGrande, true, 'declara la ventana grande');
        t.eq(resultado.model, 'claude-x');
    });

    t.test('el modelo pedido a mano pisa al de Ajustes', async () => {
        const config = ajustes.sanear({
            ia: { proveedor: 'anthropic', anthropic: { modelo: 'claude-x', apiKey: 'sk-ant-fake' } }
        }).ia;
        const resultado = await ia.armar({ model: 'claude-otro' }, config);
        t.eq(resultado.model, 'claude-otro');
    });

    t.group('proveedores · mal configurados contestan {error}');

    t.test('claude sin clave no sale a internet', async () => {
        const cliente = anthropic.cliente({ model: 'claude-x', apiKey: '' });
        const res = await cliente.ask({ system: 's', prompt: 'p' });
        t.ok(/clave/i.test(res.error), res.error);
    });

    t.test('el CLI que no está contesta con el motivo', async () => {
        const cliente = cursor.cliente({ model: 'x', bin: '/no/existe/cursor-agent' });
        const res = await cliente.ask({ system: 's', prompt: 'p' });
        t.ok(/no se pudo lanzar/i.test(res.error), res.error);
    });

    t.group('cursor · la lista de modelos del CLI');

    t.test('se leen id y nombre, y el ruido se ignora', () => {
        const lista = cursor.parsearLista([
            'Available models',
            '',
            'auto - Auto (default)',
            'claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking',
            'esto no es un modelo'
        ].join('\n'));
        t.eq(lista.length, 2);
        t.eq(lista[1].id, 'claude-sonnet-5-thinking-high');
        t.eq(lista[1].nombre, 'Claude Sonnet 5 1M Thinking');
    });
};
