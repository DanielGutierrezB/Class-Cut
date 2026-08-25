'use strict';
/**
 * Los tokens: cuánto costó pensar una clase.
 *
 * Lo importante que se prueba acá es la diferencia entre **no gastó** y **el
 * proveedor no informa**. Confundirlas es mostrar un 0 tranquilizador donde de
 * verdad hubo treinta mil tokens, y es exactamente lo que pasaba antes de que
 * el Cursor CLI empezara a contestar en JSON.
 *
 * Los tres traductores (`usoDelSobre`, `usoDeOllama`, `usoDeClaude`) se prueban
 * contra respuestas reales copiadas de cada proveedor; la del CLI salió de
 * correr `cursor-agent -p --output-format json` en esta máquina.
 */

const tokens = require('../engine/tokens');
const cursor = require('../engine/ai-cursor');
const local = require('../engine/ai-local');
const anthropic = require('../engine/ai-anthropic');

module.exports = t => {
    t.group('tokens · contar');

    t.test('un contador nuevo no informa nada porque no preguntó nada', () => {
        const total = tokens.totales(tokens.contador());
        t.eq(total.informa, false, 'sin consultas no hay nada que decir');
        t.eq(total.total, 0);
    });

    t.test('una consulta sin uso cuenta como consulta y como no informa', () => {
        const c = tokens.contador();
        tokens.sumar(c, null);
        const total = tokens.totales(c);
        t.eq(total.consultas, 1);
        t.eq(total.informa, false, 'preguntó y no vino uso: el proveedor no informa');
    });

    t.test('la entrada suma las dos cachés, que es lo que el proveedor procesó', () => {
        const c = tokens.contador();
        tokens.sumar(c, { entrada: 2, salida: 9, cacheLectura: 100, cacheEscritura: 31354 });
        const total = tokens.totales(c);
        t.eq(total.entrada, 31456, '2 + 100 + 31354');
        t.eq(total.salida, 9);
        t.eq(total.total, 31465);
        t.eq(total.informa, true);
    });

    t.test('si informó solo algunas, se dice', () => {
        const c = tokens.contador();
        tokens.sumar(c, { entrada: 10, salida: 5 });
        tokens.sumar(c, null);
        const total = tokens.totales(c);
        t.eq(total.informa, true);
        t.eq(total.parcial, true, 'un número bajo no puede leerse como barato');
    });

    t.test('la resta es lo que gastó UNA clase dentro de la corrida', () => {
        const c = tokens.contador();
        tokens.sumar(c, { entrada: 1000, salida: 100 });
        const antes = tokens.instantanea(c);
        tokens.sumar(c, { entrada: 4000, salida: 300 });
        tokens.sumar(c, { entrada: 2000, salida: 200 });

        const suyo = tokens.diferencia(antes, c);
        t.eq(suyo.consultas, 2, 'no las tres de la corrida');
        t.eq(tokens.totales(suyo).total, 6500);
    });

    t.test('la instantánea es una copia, no el contador vivo', () => {
        const c = tokens.contador();
        const foto = tokens.instantanea(c);
        tokens.sumar(c, { entrada: 500, salida: 0 });
        t.eq(foto.entrada, 0, 'la foto no cambió con el contador');
    });

    t.test('un uso con basura no rompe la cuenta', () => {
        const c = tokens.contador();
        tokens.sumar(c, { entrada: 'muchos', salida: -5, cacheLectura: null, cacheEscritura: undefined });
        t.eq(tokens.totales(c).total, 0, 'lo que no es un número no suma');
    });

    t.group('tokens · lo que devuelve cada proveedor');

    t.test('el sobre del Cursor CLI, tal como llega', () => {
        // Copiado de una corrida real: `cursor-agent 2026.08.11` contestando
        // {"ok": true}. Casi todo el prompt cae en la caché de escritura, y por
        // eso mirar solo inputTokens diría 2 donde hubo 31.356.
        const salida = JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            duration_ms: 2827,
            result: '{"ok": true}',
            session_id: 'a5a72184',
            usage: { inputTokens: 2, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 31354 }
        });

        const [respuesta, uso] = cursor.desenvolver(salida);
        t.deep(respuesta, { ok: true }, 'la respuesta del modelo sale del campo `result`');
        t.eq(tokens.totales(tokens.sumar(tokens.contador(), uso)).total, 31365);
    });

    t.test('un sobre sin `usage` se lee como "no informa", no como cero', () => {
        const salida = JSON.stringify({ type: 'result', is_error: false, result: '{"ok": true}' });
        const [respuesta, uso] = cursor.desenvolver(salida);
        t.deep(respuesta, { ok: true });
        t.eq(uso, null, 'una versión del CLI que deje de informar tiene que verse');
    });

    t.test('una respuesta pelada (el formato viejo) sigue sirviendo', () => {
        const [respuesta, uso] = cursor.desenvolver('{"corte": 12.5}');
        t.deep(respuesta, { corte: 12.5 }, 'cortar no depende de poder contar tokens');
        t.eq(uso, null);
    });

    t.test('un sobre con error se cuenta como error y no como respuesta', () => {
        const salida = JSON.stringify({ type: 'result', is_error: true, result: 'Request blocked' });
        const [respuesta] = cursor.desenvolver(salida);
        t.ok(respuesta.error, 'no se le entrega al motor un "Request blocked" como si fuera un corte');
    });

    t.test('si el sobre está bien pero el modelo no contestó JSON, el gasto igual se cuenta', () => {
        const salida = JSON.stringify({
            type: 'result', is_error: false, result: 'no sé qué contestar',
            usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 100 }
        });
        const [respuesta, uso] = cursor.desenvolver(salida);
        t.ok(respuesta.error, 'la respuesta no sirve');
        t.eq(tokens.totales(tokens.sumar(tokens.contador(), uso)).total, 112, 'pero los tokens se gastaron igual');
    });

    t.test('Ollama informa con otros nombres', () => {
        const uso = local.usoDeOllama({ prompt_eval_count: 8420, eval_count: 96 });
        t.eq(tokens.totales(tokens.sumar(tokens.contador(), uso)).total, 8516);
    });

    t.test('una respuesta de Ollama sin contadores no informa', () => {
        t.eq(local.usoDeOllama({ message: { content: '{}' } }), null);
    });

    t.test('Claude informa con otros más', () => {
        const uso = anthropic.usoDeClaude({ usage: { input_tokens: 1200, output_tokens: 40 } });
        t.eq(tokens.totales(tokens.sumar(tokens.contador(), uso)).total, 1240);
    });

    t.test('un payload de Claude sin `usage` no informa', () => {
        t.eq(anthropic.usoDeClaude({ content: [] }), null);
    });
};
