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
const oauth = require('../engine/claude-oauth');

module.exports = function (t) {
    t.group('ajustes · lo que venga del disco queda usable');

    t.test('sin archivo, ni roto, ni a medias: siempre salen completos', () => {
        for (const crudo of [null, {}, { ia: {} }, { ia: { proveedor: 'chatgpt' } }, 'basura']) {
            const limpio = ajustes.sanear(crudo);
            t.eq(limpio.ia.proveedor, 'local', 'el default es el que funciona sin cuentas');
            t.ok(limpio.ia.cursor.modelo, 'el modelo del CLI trae default');
            t.ok(!('apiKey' in limpio.ia.anthropic), 'y jamás llevan una clave');
        }
    });

    t.test('la configuración de un proveedor sobrevive aunque no esté activo', () => {
        const limpio = ajustes.sanear({
            ia: {
                proveedor: 'local',
                cursor: { modelo: 'claude-sonnet-5-thinking-high' },
                anthropic: { modelo: 'claude-x' }
            }
        });
        t.eq(limpio.ia.cursor.modelo, 'claude-sonnet-5-thinking-high');
        t.eq(limpio.ia.anthropic.modelo, 'claude-x');
    });

    t.test('una clave que venga en los ajustes NO se persiste: al Llavero', () => {
        // `sanear` es lo que se escribe al disco: si dejara pasar la clave, el
        // secreto quedaría en un JSON de texto plano que viaja en cada backup.
        const limpio = ajustes.sanear({
            ia: { anthropic: { modelo: 'claude-x', apiKey: 'sk-ant-123' } }
        });
        t.ok(!('apiKey' in limpio.ia.anthropic), 'el JSON saneado no lleva la clave');
    });

    t.group('ia · el despachador arma el proveedor pedido');

    /**
     * Config en memoria CON el campo apiKey presente: así la prueba no depende
     * del Llavero de la Mac en la que corra. El campo presente manda, aunque
     * venga vacío.
     */
    function configAnthropic(apiKey) {
        const config = ajustes.sanear({ ia: { proveedor: 'anthropic', anthropic: { modelo: 'claude-x' } } }).ia;
        config.anthropic = { ...config.anthropic, apiKey };
        return config;
    }

    t.test('cursor sin CLI y anthropic sin clave avisan, no rompen', async () => {
        const resultado = await ia.armar({}, configAnthropic(''));
        t.eq(resultado.cliente, null);
        t.ok(/clave/i.test(resultado.reason), resultado.reason);
    });

    t.test('anthropic armado con clave devuelve un cliente de ventana grande', async () => {
        const resultado = await ia.armar({}, configAnthropic('sk-ant-fake'));
        t.ok(resultado.cliente, 'hay cliente');
        t.eq(resultado.cliente.contextoGrande, true, 'declara la ventana grande');
        t.ok(resultado.cliente.paralelo > 1, 'y aguanta consultas en paralelo');
        t.eq(resultado.model, 'claude-x');
    });

    t.test('el modelo pedido a mano pisa al de Ajustes', async () => {
        const resultado = await ia.armar({ model: 'claude-otro' }, configAnthropic('sk-ant-fake'));
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

    t.group('ia · las tandas en paralelo');

    t.test('respeta el límite y conserva el orden', async () => {
        let vivas = 0;
        let pico = 0;
        const res = await ia.enTandas(3, [10, 20, 30, 40, 50, 60, 70], async (n, i) => {
            vivas++;
            pico = Math.max(pico, vivas);
            // El primero tarda más: si el orden saliera por llegada, quedaría último.
            await new Promise(r => setTimeout(r, i === 0 ? 30 : 5));
            vivas--;
            return n * 2;
        });
        t.deep(res, [20, 40, 60, 80, 100, 120, 140], 'el orden es el de entrada');
        t.ok(pico <= 3, `nunca más de 3 a la vez (pico: ${pico})`);
        t.ok(pico > 1, 'y de verdad corren juntas');
    });

    t.test('con límite 1 es la fila de siempre', async () => {
        const orden = [];
        await ia.enTandas(1, ['a', 'b', 'c'], async x => { orden.push(x); });
        t.deep(orden, ['a', 'b', 'c']);
    });

    t.group('claude · iniciar sesión');

    t.test('la URL de autorización lleva PKCE y pide solo crear la clave', () => {
        const { url, verifier } = oauth.empezar();
        const armada = new URL(url);
        t.eq(armada.origin + armada.pathname, 'https://console.anthropic.com/oauth/authorize');
        t.eq(armada.searchParams.get('code_challenge_method'), 'S256');
        t.ok(armada.searchParams.get('code_challenge'), 'viaja el hash del secreto');
        // La convención del flujo de Anthropic: el verificador hace de `state`,
        // así el código pegado ("code#state") prueba que es de ESTA sesión.
        t.eq(armada.searchParams.get('state'), verifier);
        t.eq(armada.searchParams.get('scope'), 'org:create_api_key user:profile');
        t.ok(verifier.length >= 40, 'el secreto tiene entropía de verdad');
    });

    t.test('el código pegado se entiende venga como venga', () => {
        t.eq(oauth.partirCodigo('abc123#v1', 'v1').code, 'abc123');
        t.eq(oauth.partirCodigo('  abc123#v1  ', 'v1').code, 'abc123', 'con espacios alrededor');
        t.eq(oauth.partirCodigo('https://console.anthropic.com/oauth/code/callback?code=abc123&state=v1', 'v1').code,
            'abc123', 'pegando la URL entera');
        t.ok(/otra sesión/.test(oauth.partirCodigo('abc#v2', 'v1').error), 'estado ajeno se rechaza');
        t.ok(oauth.partirCodigo('', 'v1').error, 'vacío avisa');
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
