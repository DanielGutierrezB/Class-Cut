'use strict';
/**
 * medir-contexto.js — Cuánta ventana de contexto está usando el modelo de verdad.
 *
 * Ollama no falla cuando el prompt no le entra: descarta el principio en silencio
 * y contesta igual. Un prompt largo que se cae a la mitad se ve exactamente igual
 * que uno que entró entero, así que la única forma de saberlo es preguntárselo.
 *
 * Este banco mete una consigna al comienzo de un prompt cada vez más largo y ve
 * a partir de qué tamaño el modelo deja de poder repetirla: ahí está el techo.
 *
 *   node tools/medir-contexto.js
 */

const servidor = require('../engine/ollama-server');
const ai = require('../engine/ai-local');

/** Relleno con contenido, no con la misma palabra repetida: eso se comprime. */
function relleno(palabras) {
    const salida = [];
    for (let i = 0; i < palabras; i++) salida.push(`punto${i} de la clase numero ${i % 97}`);
    return salida.join(' ');
}

async function tamañoDeVentana(cliente, numCtx) {
    const clave = 'MARIPOSA-7391';
    let ultimoBueno = 0;
    for (const palabras of [200, 600, 1200, 2000, 3000, 4500, 6000, 9000]) {
        const prompt = `La palabra clave es ${clave}. Recordala.\n\n`
            + `TEXTO DE RELLENO:\n${relleno(palabras)}\n\n`
            + 'Responde solo JSON: {"clave": "<la palabra clave que te di al principio>"}';
        const tokens = Math.round(prompt.length / 4);

        const arranque = Date.now();
        const respuesta = await cliente.ask({
            system: 'Respondes solo JSON válido.',
            prompt,
            numCtx,
            numPredict: 60
        });
        const segundos = ((Date.now() - arranque) / 1000).toFixed(1);

        // Que no conteste a tiempo no dice nada sobre la ventana: es otra cosa, y
        // mezclarlas fue lo que hizo que la primera medición no sirviera.
        if (respuesta && respuesta.error) {
            console.log(`  ~${String(tokens).padStart(5)} tokens · sin dato (${respuesta.error}) · ${segundos}s`);
            return { techo: null, corto: true, ultimoBueno };
        }
        const acerto = String(respuesta.clave || '').includes(clave);
        console.log(`  ~${String(tokens).padStart(5)} tokens · ${acerto ? 'se acuerda' : 'SE PERDIÓ EL PRINCIPIO'} · ${segundos}s`);
        if (!acerto) return { techo: tokens, ultimoBueno };
        ultimoBueno = tokens;
    }
    return { techo: null, ultimoBueno };
}

function contar(etiqueta, resultado) {
    if (resultado.corto) {
        console.log(`  → sin conclusión: dejó de contestar. Entró entero hasta ~${resultado.ultimoBueno} tokens.\n`);
    } else if (resultado.techo) {
        console.log(`  → ${etiqueta}: se corta cerca de los ${resultado.techo} tokens\n`);
    } else {
        console.log(`  → ${etiqueta}: aguantó los 9000 tokens\n`);
    }
}

(async () => {
    // A propósito el bundleado y no el mejor de la Mac: es el que va a tener
    // cualquiera que instale la app, y el grande tarda tanto que la medición se
    // vuelve un banco de velocidad en vez de uno de contexto.
    const pedido = process.argv[2] || 'qwen3:4b';
    const info = await servidor.ensure({ model: pedido });
    if (!info || !info.cliente) { console.error('No levantó Ollama:', info); process.exit(1); }
    console.log(`Ollama en ${info.cliente.url} con ${info.model} (${info.source})\n`);

    const cliente = ai.cliente({ url: info.cliente.url, model: info.model });

    console.log('SIN pedir num_ctx (lo que hacía la app):');
    contar('sin pedirlo', await tamañoDeVentana(cliente, undefined));

    console.log('PIDIENDO num_ctx = 16384:');
    contar('pidiéndolo', await tamañoDeVentana(cliente, 16384));

    servidor.stop();
    process.exit(0);
})();
