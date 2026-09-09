'use strict';
/**
 * Deshacer y rehacer lo que se le hizo a las tomas.
 *
 * Dos mitades, y la segunda es la que justifica dónde vive todo esto.
 *
 * La primera es la pila sola (`engine/deshacer.js`): que un paso se deshaga y se
 * rehaga, que rehacer se pierda al editar otra cosa, que el tope no crezca sin
 * techo, y que la foto sea de UNA toma y no de la sesión —que es lo que permite
 * deshacer algo viejo con tres tomas nuevas encima sin borrarlas—.
 *
 * La segunda pasa por el motor entero, con una sesión de verdad y su XML en el
 * disco, y prueba lo único que no se puede probar de otra manera: **que deshacer
 * reescriba el archivo.** Un deshacer que arreglara la pantalla dejaría el XML
 * con el cambio puesto, y entonces lo que se ve y lo que va a abrir Premiere
 * dirían cosas distintas. Es el motivo de que el historial esté en el motor y no
 * en la ventana, así que tiene que estar fijado acá y no en un comentario.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const historial = require('../engine/deshacer');
const grabacion = require('../engine/grabacion');
const oir = require('../engine/oir');
const workspace = require('../engine/workspace');

/** Una toma escrita corta, con lo que se le pida encima. */
function toma(id, campos) {
    return {
        id, vista: 'PV', comentario: '', inMs: 1000, outMs: 9000,
        descartada: false, palabras: [], comentarios: [], ...campos
    };
}

/* ─── La sesión de verdad ─────────────────────────────────────────────────
 *
 * Whisper no corre en las pruebas —tarda un segundo por pedazo y necesita un
 * modelo bajado—, así que lo único que se reemplaza es la oreja: `oir.escuchar`
 * contesta un guion escrito a mano. Todo lo demás es el motor real, con su WAV
 * en el disco, su ciclo de señales y su XML: es lo que hace que esta prueba
 * valga, porque el camino que se está mirando es el de escribir el archivo.
 */

/** Palabras del guion: "texto@segundo" desde que arrancó la captura. */
function guion(lista) {
    return lista.map(item => {
        const [texto, seg] = item.split('@');
        return { texto, seg: Number(seg) };
    });
}

const CLASE = guion([
    '3,@1', '2,@1.4', '1.@1.8',
    'Hoy@2.5', 'vamos@2.8', 'a@3.1', 'armar@3.4', 'un@3.7', 'flujo@4', 'de@4.3', 'trabajo@4.6',
    'Pausa.@8',
    'Retomamos.@11',
    'Lo@12', 'que@12.3', 'quedaba@12.6', 'pendiente@12.9', 'era@13.2', 'el@13.5', 'ejercicio@13.8',
    'Pausa.@17',
    'Retomamos.@20',
    'Y@21', 'ahora@21.3', 'las@21.6', 'reglas@21.9',
    // Lo de acá abajo entra recién cuando la prueba pide seguir grabando: es lo
    // que deja ver qué pasa al deshacer algo viejo con tomas nuevas encima.
    'Retomamos.@30',
    'Miren@31', 'esto@31.3', 'en@31.6', 'la@31.9', 'pantalla@32.2'
]);

const TASA = 16000;

/** Cuánto silencio hay que escribir para que el audio llegue a ese segundo. */
function silencio(segundos) {
    return Buffer.alloc(TASA * 2 * segundos);
}

/**
 * Arranca una sesión, le mete silencio y empuja el ciclo a mano.
 *
 * El silencio alcanza porque las palabras no salen del audio sino del guion: lo
 * que el WAV tiene que hacer es existir y medir lo que dice medir, que es de
 * donde el motor saca hasta dónde puede escuchar.
 */
async function grabar(dir, segundos) {
    const antes = oir.escuchar;
    oir.escuchar = async p => ({
        palabras: CLASE
            .map(w => ({ t: p.sesion.desdeMs + Math.round(w.seg * 1000), texto: w.texto }))
            .filter(w => w.t >= p.desdeMs && w.t <= p.hastaMs),
        colapsadas: 0,
        rellenadas: 0
    });

    grabacion.iniciar({ dir, clase: 1, curso: 'curso', sampleRate: TASA, canales: 1, sinReloj: true });
    await seguir(segundos);
    return () => { oir.escuchar = antes; };
}

/** Otro tramo de clase: más audio y otra pasada del ciclo de señales. */
async function seguir(segundos) {
    grabacion.pcm(silencio(segundos));
    await grabacion.buscarSenales();
    // Las tomas que cerraron se releen de a una en una cola que no se exporta;
    // se le da lugar para que termine antes de mirar, que si no la primera
    // edición cae sobre una toma que el motor todavía está reescribiendo.
    for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
}

/** Lo que quedó escrito al lado del XML, que es la verdad del archivo. */
function sidecarDe(dir, estado) {
    return JSON.parse(fs.readFileSync(workspace.notasArchivos(dir, estado.secuencia).json, 'utf8'));
}

/**
 * Corre `fn` con una sesión grabada y limpia todo después.
 *
 * `fn(dir, estado, seguir)`: `seguir` mete más clase, para las pruebas que
 * necesitan que lleguen tomas nuevas después de haber editado algo.
 */
async function conSesion(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deshacer-'));
    let devolver = () => {};
    try {
        devolver = await grabar(dir, 24);
        await fn(dir, grabacion.resumen(), seguir);
    } finally {
        devolver();
        grabacion.apagar();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = async t => {
    t.group('deshacer · la pila sola');

    t.test('un paso se deshace y se rehace', () => {
        const h = historial.nueva();
        const tomas = [toma(1, { vista: 'PV' })];
        const antes = historial.foto(tomas[0]);
        tomas[0].vista = 'S';
        historial.anotar(h, { que: 'poner la toma 1 en S', tipo: 'vista', id: 1, antes, despues: historial.foto(tomas[0]) });

        const atras = historial.sacar(h, 'atras');
        historial.poner(tomas, atras.id, atras.foto);
        t.eq(tomas[0].vista, 'PV', 'volvió a la que tenía');

        const adelante = historial.sacar(h, 'adelante');
        historial.poner(tomas, adelante.id, adelante.foto);
        t.eq(tomas[0].vista, 'S', 'y rehacer la devuelve');
    });

    t.test('el paso dice qué fue, para poder decirlo al revertirlo', () => {
        // Con quince tomas en pantalla y el scroll donde lo dejó quien estaba
        // leyendo, un cambio que se revierte lejos de la vista es invisible.
        const h = historial.nueva();
        historial.anotar(h, { que: 'descartar la toma 2', tipo: 'descartar', id: 2, antes: null, despues: null });
        t.eq(historial.proximo(h, 'atras').que, 'descartar la toma 2');
        t.eq(historial.proximo(h, 'adelante'), null, 'y para adelante todavía no hay nada');
    });

    t.test('sin nada anotado no se saca nada', () => {
        const h = historial.nueva();
        t.eq(historial.sacar(h, 'atras'), null);
        t.eq(historial.sacar(h, 'adelante'), null);
    });

    t.test('editar después de deshacer borra el futuro', () => {
        // Ese futuro dejó de existir: rehacerlo pondría encima un cambio que
        // salió de un estado que ya no es el que hay.
        const h = historial.nueva();
        historial.anotar(h, { que: 'uno', tipo: 'vista', id: 1, antes: null, despues: null });
        historial.sacar(h, 'atras');
        t.eq(historial.pasos(h).adelante, 1);
        historial.anotar(h, { que: 'otro', tipo: 'nota', id: 1, antes: null, despues: null });
        t.deep(historial.pasos(h), { atras: 1, adelante: 0 });
    });

    t.test('el historial tiene tope y tira los más viejos', () => {
        const h = historial.nueva();
        for (let i = 0; i < historial.TOPE + 10; i++) {
            historial.anotar(h, { que: `paso ${i}`, tipo: 'vista', id: 1, antes: null, despues: null });
        }
        t.eq(historial.pasos(h).atras, historial.TOPE);
        t.eq(historial.proximo(h, 'atras').que, `paso ${historial.TOPE + 9}`, 'el último sigue estando');
    });

    t.group('deshacer · la foto es de una toma, no de la sesión');

    t.test('la foto no cambia cuando la toma cambia', () => {
        const t1 = toma(1, { comentarios: [{ texto: 'a', comentario: 'x' }] });
        const f = historial.foto(t1);
        t1.vista = 'R';
        t1.comentarios = t1.comentarios.concat({ texto: 'b', comentario: 'y' });
        t.eq(f.vista, 'PV');
        t.eq(f.comentarios.length, 1, 'la lista de la foto es otra lista');
    });

    t.test('deshacer algo viejo no toca las tomas que entraron mientras tanto', () => {
        // El caso que define si esto sirve grabando: se descarta la toma 1, pasan
        // cinco minutos, entran las tomas 2, 3 y 4, y alguien se arrepiente. Una
        // foto de la sesión entera se llevaría puestas las tres nuevas.
        const tomas = [toma(1, { descartada: false })];
        const h = historial.nueva();
        const antes = historial.foto(tomas[0]);
        tomas[0].descartada = true;
        historial.anotar(h, { que: 'descartar la toma 1', tipo: 'descartar', id: 1, antes, despues: historial.foto(tomas[0]) });

        tomas.push(toma(2), toma(3), toma(4, { outMs: null }));
        const paso = historial.sacar(h, 'atras');
        historial.poner(tomas, paso.id, paso.foto);

        t.deep(tomas.map(x => x.id), [1, 2, 3, 4], 'las tres nuevas siguen ahí');
        t.eq(tomas[0].descartada, false, 'y la vieja volvió atrás');
    });

    t.test('la toma se rellena encima y no se reemplaza el objeto', () => {
        // La cola de relecturas y la consulta que mide la toma se quedan con la
        // referencia mientras esperan: reemplazando el objeto, una respuesta que
        // llega medio minuto después caería en una toma que ya no está.
        const tomas = [toma(1, { vista: 'PV' })];
        const suyo = tomas[0];
        historial.poner(tomas, 1, { ...toma(1), vista: 'MG' });
        t.ok(tomas[0] === suyo, 'es el mismo objeto');
        t.eq(suyo.vista, 'MG');
    });

    t.test('los campos que la foto no tiene se van, no quedan pegados', () => {
        // Deshacer un "cerrar" tiene que devolver la toma a abierta: si `outMs`
        // se quedara del estado de después, la toma volvería cerrada y el paso no
        // se vería.
        const tomas = [toma(1, { outMs: 9000, cerradaSola: true })];
        const abierta = toma(1, { outMs: null });
        delete abierta.cerradaSola;
        historial.poner(tomas, 1, abierta);
        t.eq(tomas[0].outMs, null);
        t.eq('cerradaSola' in tomas[0], false);
    });

    t.group('deshacer · una toma eliminada vuelve a su sitio');

    t.test('la foto en null es "esta toma no existía"', () => {
        const tomas = [toma(1), toma(2), toma(3)];
        historial.poner(tomas, 2, null);
        t.deep(tomas.map(x => x.id), [1, 3]);
    });

    t.test('y vuelve por su número, no al final', () => {
        // Es lo que hace que eliminar se pueda deshacer sin dejar la lista fuera
        // de orden: la lista se lee como pasó la clase.
        const tomas = [toma(1), toma(3)];
        historial.poner(tomas, 2, toma(2));
        t.deep(tomas.map(x => x.id), [1, 2, 3]);
    });

    t.test('la primera vuelve al principio y la última al final', () => {
        t.eq(historial.dondeEntra([toma(2), toma(3)], 1), 0);
        t.eq(historial.dondeEntra([toma(1), toma(2)], 5), 2);
        t.eq(historial.dondeEntra([], 1), 0);
    });

    t.group('deshacer · lo único que no se puede deshacer');

    t.test('no se repone una toma abierta si ya hay otra abierta', () => {
        // Se cierra una toma a mano, el profesor sigue hablando, el ciclo abre la
        // siguiente, y entonces alguien se arrepiente del cierre. Dos tomas sin
        // OUT rompen el ciclo de señales: de ahí en adelante las palabras van a
        // "la abierta" cuando ya no hay tal cosa.
        const tomas = [toma(1, { outMs: 9000 }), toma(2, { outMs: null })];
        t.ok(historial.dejariaDosAbiertas(tomas, 1, toma(1, { outMs: null })));
    });

    t.test('pero sí si la de ahora ya está cerrada', () => {
        const tomas = [toma(1, { outMs: 9000 }), toma(2, { outMs: 20000 })];
        t.eq(historial.dejariaDosAbiertas(tomas, 1, toma(1, { outMs: null })), false);
    });

    t.test('y reponer una toma CERRADA nunca molesta', () => {
        // Descartar, comentar, la vista, un borde, incluso eliminar: ninguno
        // depende de nada que haya pasado después.
        const tomas = [toma(1, { outMs: 9000 }), toma(2, { outMs: null })];
        t.eq(historial.dejariaDosAbiertas(tomas, 1, toma(1, { outMs: 9000 })), false);
        t.eq(historial.dejariaDosAbiertas(tomas, 1, null), false, 'ni volver a eliminarla');
    });

    t.test('volver a abrir la que ya está abierta no cuenta como dos', () => {
        const tomas = [toma(1, { outMs: 9000 }), toma(2, { outMs: null })];
        t.eq(historial.dejariaDosAbiertas(tomas, 2, toma(2, { outMs: null })), false);
    });

    t.group('deshacer · con el motor y el XML de verdad');

    // Las de acá abajo comparten la misma clase grabada: tres tomas, las dos
    // primeras cerradas por "Pausa" y la tercera abierta.

    t.test('la clase de mentira sale con tres tomas y la última abierta', async () => {
        await conSesion((dir, e) => {
            t.eq(e.tomas.length, 3);
            t.eq(e.tomas[2].outMs, null, 'la tercera sigue grabando');
            t.ok(e.tomas[0].palabras.length > 0, 'y tienen texto');
        });
    });

    t.test('cambiar la vista deja un paso para deshacer, con su nombre', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const puesta = grabacion.editar({ tipo: 'vista', toma: id, vista: 'S' });
            t.eq(puesta.tomas[0].vista, 'S');
            t.eq(puesta.historia.atras, 1);
            t.eq(puesta.historia.queAtras, `poner la toma ${id} en S`);
        });
    });

    t.test('**deshacer reescribe el XML**, no solo la pantalla', async () => {
        // La prueba que decide dónde vive el historial. Si esto pasara en la
        // ventana, el archivo se quedaría con la vista cambiada y el editor
        // abriría en Premiere algo que la pantalla no dice.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'vista', toma: id, vista: 'MG' });
            t.eq(sidecarDe(dir, e).tomas[0].vista, 'MG', 'el archivo se escribió con el cambio');

            const r = grabacion.deshacer();
            t.ok(r.ok);
            t.eq(r.que, `poner la toma ${id} en MG`);
            t.eq(sidecarDe(dir, e).tomas[0].vista, 'PV', 'y deshacer lo volvió a escribir');
            t.eq(r.estado.tomas[0].vista, 'PV', 'la pantalla dice lo mismo que el archivo');
        });
    });

    t.test('rehacer lo vuelve a poner, en el archivo también', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'vista', toma: id, vista: 'R' });
            grabacion.deshacer();
            const r = grabacion.rehacer();
            t.ok(r.ok);
            t.eq(sidecarDe(dir, e).tomas[0].vista, 'R');
            t.eq(r.estado.historia.atras, 1, 'y el paso volvió a la pila de atrás');
        });
    });

    t.test('las siete acciones de la pantalla se deshacen', async () => {
        // La lista entera del pedido, cada una con su ida y su vuelta. Está junta
        // a propósito: lo que se rompe cuando se agrega un tipo de cambio nuevo es
        // que ese tipo no quede anotado, y eso se ve mirando la lista completa.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const cuando = e.tomas[0].palabras[1].t;
            const pasos = [
                [{ tipo: 'vista', toma: id, vista: 'S' }, x => x.tomas[0].vista, 'PV', 'S'],
                [{ tipo: 'nota', toma: id, texto: 'mirar el audio' }, x => x.tomas[0].comentario, '', 'mirar el audio'],
                [{ tipo: 'descartar', toma: id, descartada: true }, x => x.tomas[0].descartada, false, true],
                [{ tipo: 'comentar', toma: id, desdeMs: cuando, hastaMs: cuando, texto: 'vamos', comentario: 'acá' },
                    x => x.tomas[0].comentarios.length, 0, 1]
            ];
            for (const [cambio, leer, sin, con] of pasos) {
                t.eq(leer(grabacion.editar(cambio)), con, `${cambio.tipo} se aplicó`);
                t.eq(leer(grabacion.deshacer().estado), sin, `${cambio.tipo} se deshizo`);
                t.eq(leer(grabacion.rehacer().estado), con, `${cambio.tipo} se rehizo`);
                t.eq(leer(grabacion.deshacer().estado), sin, `y se volvió a deshacer`);
            }

            // Borrar un comentario: hace falta que haya uno.
            grabacion.editar({ tipo: 'comentar', toma: id, desdeMs: cuando, hastaMs: cuando, texto: 'vamos', comentario: 'acá' });
            grabacion.editar({ tipo: 'borrar-comentario', toma: id, indice: 0 });
            t.eq(grabacion.resumen().tomas[0].comentarios.length, 0);
            t.eq(grabacion.deshacer().estado.tomas[0].comentarios.length, 1, 'el comentario borrado vuelve');
        });
    });

    t.test('cerrar la toma a mano se deshace y la toma vuelve a estar abierta', async () => {
        // Es el botón que se aprieta apurado, en medio de una interrupción: es el
        // error más probable de la pantalla y tiene que costar una tecla.
        await conSesion((dir, e) => {
            const abierta = e.tomas[2].id;
            const cerrada = grabacion.cerrarToma();
            t.ok(cerrada.tomas[2].outMs != null, 'quedó cerrada');
            t.eq(cerrada.historia.queAtras, `cerrar la toma ${abierta}`);

            const r = grabacion.deshacer();
            t.ok(r.ok);
            t.eq(r.estado.tomas[2].outMs, null, 'y volvió a estar abierta');
            t.eq(r.estado.abierta, abierta);
        });
    });

    t.test('un borde movido se deshace, y el texto se vuelve a repartir', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const antes = e.tomas[0].inMs;
            const otra = e.tomas[0].palabras[2].t;
            grabacion.editar({ tipo: 'borde', toma: id, borde: 'in', paredMs: otra });
            t.eq(grabacion.resumen().tomas[0].inMs, otra);

            const r = grabacion.deshacer();
            t.eq(r.que, `mover el IN de la toma ${id}`);
            t.eq(r.estado.tomas[0].inMs, antes);
        });
    });

    t.test('un arrastre que volvió al mismo hueco no deja paso', async () => {
        // Si dejara uno, deshacerlo no se vería y el editor apretaría de nuevo
        // pensando que el botón no funciona.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'borde', toma: id, borde: 'in', paredMs: e.tomas[0].inMs });
            t.eq(grabacion.resumen().historia.atras, 0);
        });
    });

    t.group('eliminar · la única acción destructiva');

    t.test('una toma descartada se elimina de la sesión', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'descartar', toma: id, descartada: true });
            const r = grabacion.editar({ tipo: 'eliminar', toma: id });
            t.eq(r.tomas.length, 2, 'quedan dos');
            t.eq(r.tomas.some(x => x.id === id), false);
            t.eq(sidecarDe(dir, e).tomas.some(x => x.id === id), false, 'y del archivo también se fue');
        });
    });

    t.test('una toma viva no se elimina: descartar primero es parte del gesto', async () => {
        // Son dos decisiones y no una, y es la mitad de por qué esto no pregunta
        // nada. La otra mitad es que se deshace.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const r = grabacion.editar({ tipo: 'eliminar', toma: id });
            t.eq(r.tomas.length, 3, 'sigue estando');
            t.eq(r.historia.atras, 0, 'y no dejó un paso que no hizo nada');
        });
    });

    t.test('eliminar se deshace, y por eso no hace falta ningún cartel', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const texto = e.tomas[0].palabras.length;
            grabacion.editar({ tipo: 'descartar', toma: id, descartada: true });
            grabacion.editar({ tipo: 'eliminar', toma: id });

            const r = grabacion.deshacer();
            t.ok(r.ok);
            t.eq(r.que, `eliminar la toma ${id}`);
            t.eq(r.estado.tomas.length, 3, 'volvió');
            t.eq(r.estado.tomas[0].id, id, 'y a su sitio, no al final');
            t.eq(r.estado.tomas[0].palabras.length, texto, 'con su texto entero');
            t.ok(r.estado.tomas[0].descartada, 'y descartada, que es como estaba');
            t.eq(sidecarDe(dir, e).tomas.length, 3, 'el archivo también la tiene de vuelta');
        });
    });

    t.test('rehacer la vuelve a eliminar', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'descartar', toma: id, descartada: true });
            grabacion.editar({ tipo: 'eliminar', toma: id });
            grabacion.deshacer();
            const r = grabacion.rehacer();
            t.ok(r.ok);
            t.eq(r.estado.tomas.length, 2);
        });
    });

    t.group('deshacer · mientras la clase sigue grabando');

    t.test('deshacer lo viejo funciona igual con tomas nuevas encima', async () => {
        // El caso que decide si esto sirve grabando: se descarta una toma, la
        // clase sigue, entra una toma más, y entonces alguien se arrepiente.
        await conSesion(async (dir, e, mas) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'descartar', toma: id, descartada: true });
            await mas(10);
            t.eq(grabacion.resumen().tomas.length, 4, 'llegó una toma nueva');

            const r = grabacion.deshacer();
            t.ok(r.ok);
            t.eq(r.estado.tomas.length, 4, 'y sigue estando después de deshacer');
            t.eq(r.estado.tomas[0].descartada, false, 'lo viejo volvió atrás');
            t.eq(sidecarDe(dir, e).tomas.length, 4, 'el archivo también las tiene a las cuatro');
        });
    });

    t.test('deshacer un cierre con otra toma ya abierta se planta y lo dice', async () => {
        // Se cierra a mano, el profesor sigue, el ciclo abre la siguiente.
        // Reponer la toma a "abierta" dejaría dos sin OUT, y de ahí en adelante
        // las palabras van a "la abierta" cuando ya no hay tal cosa: el conteo
        // siguiente cerraría una de las dos y la otra se quedaría abierta para
        // siempre, o sea fuera del XML.
        await conSesion(async (dir, e, mas) => {
            const cerrada = e.tomas[2].id;
            grabacion.cerrarToma();
            await mas(10);
            const ahora = grabacion.resumen();
            t.eq(ahora.tomas.length, 4, 'el "Retomamos" abrió la toma siguiente');
            t.ok(ahora.abierta && ahora.abierta !== cerrada);

            const r = grabacion.deshacer();
            t.eq(r.ok, false);
            t.ok(r.error.includes('otra toma'), 'dice por qué no puede');
            t.ok(r.estado.tomas[2].outMs != null, 'y no tocó nada');
            t.eq(r.estado.historia.atras, 1, 'el paso sigue en la pila, esperando');
        });
    });

    t.test('nada que deshacer se contesta sin error y sin tocar nada', async () => {
        await conSesion((dir, e) => {
            const r = grabacion.deshacer();
            t.eq(r.ok, false);
            t.eq(r.error, undefined, 'no es un problema: es que no hay nada');
            t.eq(r.estado.tomas.length, 3);
        });
    });

    t.test('sin sesión no hay historial que mover', () => {
        // La pantalla se puede estar mirando con una clase ya terminada.
        grabacion.apagar();
        t.deep(grabacion.deshacer(), { ok: false, estado: null });
        t.deep(grabacion.rehacer(), { ok: false, estado: null });
    });
};
