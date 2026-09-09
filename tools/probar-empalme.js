'use strict';
/**
 * probar-empalme.js — La validación del empalme, contra el modelo de verdad.
 *
 *   node tools/probar-empalme.js
 *
 * Las pruebas de `tests/empalme.test.js` corren con respuestas inyectadas y sin
 * red, que es lo que hay que tener: son rápidas y no dependen de qué proveedor
 * haya configurado la Mac donde corran. Lo que NO pueden decir es si el prompt
 * funciona — si el modelo entiende que tiene que señalar una palabra y no
 * escribir un comentario, y si lo que devuelve pasa la aduana y se puede
 * ejecutar. Eso solo se sabe corriéndolo.
 *
 * Los cuatro casos son a mano y a propósito. El primero es el que motivó todo
 * esto —el profesor resume con otras palabras lo que ya había dicho—, el segundo
 * es el que tiene que salir en falso —dos tomas del mismo tema que no repiten
 * nada—, el tercero es la trampa (el arranque continúa la frase donde había
 * quedado, que se parece muchísimo a repetirla y no lo es) y el cuarto repite de
 * verdad pero a mitad de frase, así que el arreglo costaría más que el defecto.
 */

const empalme = require('../engine/empalme');
const vivo = require('../engine/notas-vivo');
const ia = require('../engine/ia');
const { tardo } = require('./lib/cli');

const BASE = Date.UTC(2026, 8, 8, 15, 0, 0);
const RITMO_MS = 350;

/** Una toma con sus palabras repartidas a ritmo de clase. */
function toma(id, desdeMs, texto) {
    const palabras = texto.trim().split(/\s+/).filter(Boolean)
        .map((p, i) => ({ t: desdeMs + i * RITMO_MS, texto: p }));
    return {
        id,
        descartada: false,
        inMs: desdeMs,
        outMs: palabras[palabras.length - 1].t + RITMO_MS,
        palabras
    };
}

const CASOS = [
    {
        nombre: 'la retoma con otras palabras (tiene que sugerir)',
        esperado: true,
        previo: toma(1, BASE, `Bueno, entonces lo que hicimos hasta acá fue levantar el servidor
            y dejarlo escuchando en el puerto tres mil. La conexión a la base de datos no se abre
            de nuevo en cada consulta: hay un pool que reparte unas pocas conexiones entre todas
            las consultas que llegan.`),
        actual: toma(2, BASE + 120000, `Cada consulta no se arma su propia conexión, ¿sí? El pool
            tiene unas cuantas abiertas y las va prestando. Ahora, ese pool tiene un tamaño, y ese
            tamaño se configura, y ahí es donde la gente se equivoca.`)
    },
    {
        nombre: 'dos tomas del mismo tema que no repiten (no tiene que sugerir)',
        esperado: false,
        previo: toma(1, BASE, `Y entonces el pool nos deja reusar las conexiones, que era el
            problema que teníamos al principio con las consultas que llegaban todas juntas y
            tardaban una eternidad en contestar.`),
        actual: toma(2, BASE + 120000, `Vamos a hablar ahora de los índices, que es otra cosa
            completamente distinta: tiene que ver con cómo la base encuentra las filas que le
            estás pidiendo sin leerse la tabla entera.`)
    },
    {
        nombre: 'la frase que sigue donde había quedado (no tiene que sugerir)',
        esperado: false,
        previo: toma(1, BASE, `Así que el pool arranca con cinco conexiones abiertas y las va
            prestando a medida que llegan las consultas. Ahora, si llegan más consultas que
            conexiones, lo que pasa es que`),
        actual: toma(2, BASE + 120000, `las que sobran se quedan esperando en una cola hasta que
            alguna conexión se libera. Y si esperan demasiado, se caen con un timeout.`)
    },
    {
        // Repite, y aun así no hay botón: lo repetido arranca a mitad de frase,
        // así que recortarlo dejaría la toma anterior terminando en "es que". El
        // modelo puede tener toda la razón y la sugerencia igual no sale, porque
        // ese final es el que después reancla el bloque en post.
        nombre: 'repite, pero arrancando a mitad de frase (no se puede ofrecer)',
        esperado: false,
        previo: toma(1, BASE, `Bueno, entonces lo que hicimos hasta acá fue levantar el servidor
            y dejarlo escuchando en el puerto tres mil. Y acá lo importante, lo que quiero que les
            quede, es que la conexión a la base de datos no se abre de nuevo en cada consulta: hay
            un pool que reparte unas pocas conexiones entre todas las consultas que llegan.`),
        actual: toma(2, BASE + 120000, `Cada consulta no se arma su propia conexión, ¿sí? El pool
            tiene unas cuantas abiertas y las va prestando. Ahora, ese pool tiene un tamaño, y ese
            tamaño se configura, y ahí es donde la gente se equivoca.`)
    }
];

async function main() {
    const estado = ia.estado();
    console.log(`Proveedor: ${estado.proveedor} · ${estado.model} · ${estado.estado}`);
    if (estado.estado !== 'listo') {
        console.log(`No hay con qué probar: ${estado.reason}`);
        process.exit(1);
    }

    const { cliente, reason } = await ia.armar({});
    if (!cliente) {
        console.log(`No se pudo armar el cliente: ${reason}`);
        process.exit(1);
    }

    let bien = 0;
    for (const caso of CASOS) {
        console.log(`\n─── ${caso.nombre}`);
        const parecido = empalme.parecidoDeLosBordes(caso.previo, caso.actual);
        const regla = empalme.porRegla(caso.previo, caso.actual);
        console.log(`parecido de los bordes: ${parecido.toFixed(2)} (se pregunta desde ${empalme.PARECIDO_PARA_PREGUNTAR})`);
        console.log(`la regla sola: ${regla ? `corta en ${regla.paredMs}` : 'no encontró nada'}`);

        if (regla) {
            console.log('Resuelto sin modelo: no se consulta.');
            continue;
        }
        if (parecido < empalme.PARECIDO_PARA_PREGUNTAR) {
            console.log('Por debajo del listón: no se consulta.');
            if (!caso.esperado) bien++;
            continue;
        }

        const desde = Date.now();
        const respuesta = await cliente.ask({
            system: empalme.SYSTEM,
            prompt: empalme.prompt(caso.previo, caso.actual),
            numPredict: 500
        });
        console.log(`contestó en ${tardo(Date.now() - desde)}`);
        console.log(`crudo: ${JSON.stringify(respuesta)}`);

        if (respuesta && respuesta.error) {
            console.log(`ERROR del proveedor: ${respuesta.error}`);
            continue;
        }

        const leido = empalme.validar(respuesta, caso.previo);
        if (!leido) {
            console.log('La aduana lo tiró (o el modelo dijo que no repite).');
            if (!caso.esperado) bien++;
            continue;
        }

        // Y lo que de verdad hay que ver: que de eso salga un cambio ejecutable.
        const sugerencia = empalme.armarSugerencia(
            caso.previo, caso.actual, leido.paredMs, 'modelo', leido.porque);
        if (!sugerencia) {
            console.log('Pasó la aduana pero el corte no se puede hacer: sin sugerencia.');
            if (!caso.esperado) bien++;
            continue;
        }

        console.log(`porque:   ${sugerencia.porque}`);
        console.log(`subraya:  "${sugerencia.enLaAnterior.texto}"`);
        console.log(`ajuste:   ${JSON.stringify(sugerencia.ajuste)}`);

        // Ejecutarlo de verdad sobre una copia, que es lo único que prueba que
        // "Ajustar corte" anda: el mismo `moverBorde` que usa la pantalla.
        const copia = JSON.parse(JSON.stringify(caso.previo));
        const movido = vivo.moverBorde(copia, 'out', sugerencia.ajuste.paredMs);
        const quedo = (copia.palabras || []).filter(w => w.t < copia.outMs);
        console.log(`ejecutado: ${movido ? 'sí' : 'NO'} · la anterior queda en "…${quedo.slice(-6).map(w => w.texto).join(' ')}"`);
        if (movido && caso.esperado) bien++;
    }

    console.log(`\n${bien} de ${CASOS.length} casos salieron como se esperaba.`);
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
