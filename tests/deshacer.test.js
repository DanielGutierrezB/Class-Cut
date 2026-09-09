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
const ia = require('../engine/ia');
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
 *
 * Y lo otro que se reemplaza es el proveedor de modelo, por dos motivos que van
 * juntos. Uno: sin tocarlo, la cobertura del temario saldría a preguntarle de
 * verdad al que esté configurado en ESTA Mac, o sea red y minutos adentro de una
 * prueba. El otro: `gpu.sePuedeConsultar` lee el proveedor de Ajustes, así que
 * la misma prueba mediría o se abstendría según quién la corra. Se dice que hay
 * un proveedor remoto —para que no se abstenga— y que armarlo no da cliente, y
 * entonces `temario.medir` cae en su respaldo por palabras: sin red, sin espera
 * y siempre el mismo número.
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
    const oreja = oir.escuchar;
    const estadoDeIa = ia.estado;
    const armarIa = ia.armar;

    oir.escuchar = async p => ({
        palabras: CLASE
            .map(w => ({ t: p.sesion.desdeMs + Math.round(w.seg * 1000), texto: w.texto }))
            .filter(w => w.t >= p.desdeMs && w.t <= p.hastaMs),
        colapsadas: 0,
        rellenadas: 0
    });
    ia.estado = () => ({ estado: 'listo', proveedor: 'anthropic', model: 'de mentira', reason: '' });
    ia.armar = async () => ({ cliente: null, proveedor: 'anthropic', reason: 'no hay modelo en las pruebas' });

    grabacion.iniciar({ dir, clase: 1, curso: 'curso', sampleRate: TASA, canales: 1, sinReloj: true });
    await seguir(segundos);
    return () => {
        oir.escuchar = oreja;
        ia.estado = estadoDeIa;
        ia.armar = armarIa;
    };
}

/**
 * Le da lugar a lo que quedó en el aire: la relectura de una toma que cerró y la
 * medición de la cobertura, que son promesas que nadie exporta.
 *
 * Sin esto la primera edición cae sobre una toma que el motor todavía está
 * reescribiendo, y una cobertura recién pedida se lee cuando todavía es null.
 */
async function respirar() {
    for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
}

/** Otro tramo de clase: más audio y otra pasada del ciclo de señales. */
async function seguir(segundos) {
    grabacion.pcm(silencio(segundos));
    await grabacion.buscarSenales();
    await respirar();
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
        historial.anotar(h, {
            que: 'descartar la toma 2', tipo: 'descartar', id: 2,
            antes: toma(2), despues: toma(2, { descartada: true })
        });
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
        historial.anotar(h, { que: 'uno', tipo: 'vista', id: 1, antes: toma(1), despues: toma(1, { vista: 'S' }) });
        historial.sacar(h, 'atras');
        t.eq(historial.pasos(h).adelante, 1);
        historial.anotar(h, { que: 'otro', tipo: 'nota', id: 1, antes: toma(1), despues: toma(1, { comentario: 'x' }) });
        t.deep(historial.pasos(h), { atras: 1, adelante: 0 });
    });

    t.test('el historial tiene tope y tira los más viejos', () => {
        const h = historial.nueva();
        for (let i = 0; i < historial.TOPE + 10; i++) {
            historial.anotar(h, {
                que: `paso ${i}`, tipo: 'vista', id: 1,
                antes: toma(1), despues: toma(1, { vista: 'S' })
            });
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

    t.test('el OUT movido después de escribir la nota se deshace, y deshace el OUT', async () => {
        // La secuencia de una persona, y en este orden: se escribe la nota de la
        // toma y después se corre la línea roja. Salió de la corrida en la app
        // (`tools/probar-vivo.js`), donde el botón ofrecía deshacer el OUT y lo que
        // volvía era otra cosa. Las dos mitades se prueban acá: que se deshaga el
        // paso que el botón PROMETE, y que la pila quede como corresponde.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const outAntes = e.tomas[0].outMs;
            grabacion.editar({ tipo: 'nota', toma: id, texto: 'Repite el arranque' });
            const otro = e.tomas[0].palabras[2].t;
            const movido = grabacion.editar({ tipo: 'borde', toma: id, borde: 'out', paredMs: otro });
            t.eq(movido.tomas[0].outMs, otro, 'el OUT se movió');
            t.eq(movido.historia.atras, 2, 'la nota y el borde, dos pasos');
            t.eq(movido.historia.queAtras, `mover el OUT de la toma ${id}`);

            const r = grabacion.deshacer();
            t.ok(r.ok);
            t.eq(r.que, `mover el OUT de la toma ${id}`, 'se deshace lo que el botón prometía');
            t.eq(r.estado.tomas[0].outMs, outAntes, 'y el OUT volvió a donde estaba');
            t.eq(r.estado.tomas[0].comentario, 'Repite el arranque', 'sin tocar la nota');
            t.eq(r.estado.historia.atras, 1, 'queda la nota para deshacer');
            t.eq(r.estado.historia.adelante, 1, 'y el borde para rehacer');
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

    /* ─── Los pasos que al deshacerse no se ven ───────────────────────────
     *
     * La regla del borde de acá arriba, pedida a TODOS los gestos y en un solo
     * sitio: al historial entra lo que cambió la toma, y nada más. Un paso
     * fantasma se siente peor que un botón roto —Cmd-Z dice que deshizo algo, la
     * pantalla no se mueve— y encima se come el paso que iba para el cambio de
     * verdad.
     *
     * Está la lista entera y no solo los que se rompieron, porque lo que hay que
     * poder mirar de un golpe es qué pasa con cada tipo de cambio cuando se lo
     * manda dos veces o cuando el motor se planta.
     */
    t.group('el historial · solo entra lo que cambió algo');

    t.test('reabrir una toma que no es la última no deja paso', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const r = grabacion.editar({ tipo: 'reabrir', toma: id });
            t.eq(r.tomas[0].outMs, e.tomas[0].outMs, 'la toma no se movió');
            t.eq(r.historia.atras, 0, 'y no dejó un paso que no hizo nada');
        });
    });

    t.test('reabrir que el motor rechaza no se come el Cmd-Z del cambio anterior', async () => {
        // Cómo llega este clic: el botón se ofrece mirando el estado que está en
        // pantalla, y entre ese repintado y el clic pasan hasta tres segundos —lo
        // que tarda el ciclo de señales en abrir la toma siguiente—. El gesto sale
        // con el botón que se veía y acá ya no se puede hacer nada.
        await conSesion(async (dir, e, mas) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'vista', toma: id, vista: 'S' });
            await mas(10);
            const antes = grabacion.resumen();
            t.eq(antes.tomas.length, 4, 'el "Retomamos" abrió la toma siguiente');

            grabacion.editar({ tipo: 'reabrir', toma: antes.tomas[2].id });
            t.eq(grabacion.resumen().tomas[2].outMs, antes.tomas[2].outMs, 'la toma no se movió');

            const r = grabacion.deshacer();
            t.eq(r.que, `poner la toma ${id} en S`, 'el Cmd-Z va al cambio de verdad');
            t.eq(r.estado.tomas[0].vista, 'PV');
        });
    });

    t.test('poner la vista que la toma ya tenía no deja paso', async () => {
        // El clic más fácil de dar de toda la pantalla: el selector de vista es
        // una fila de cinco botones y el que está elegido también se puede apretar.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const r = grabacion.editar({ tipo: 'vista', toma: id, vista: e.tomas[0].vista });
            t.eq(r.tomas[0].vista, 'PV');
            t.eq(r.historia.atras, 0);
        });
    });

    t.test('escribir la misma nota otra vez deja un paso, no dos', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'nota', toma: id, texto: 'mirar el audio' });
            const r = grabacion.editar({ tipo: 'nota', toma: id, texto: 'mirar el audio' });
            t.eq(r.tomas[0].comentario, 'mirar el audio');
            t.eq(r.historia.atras, 1);
        });
    });

    t.test('descartar la que ya estaba descartada no deja paso', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'descartar', toma: id, descartada: true });
            const r = grabacion.editar({ tipo: 'descartar', toma: id, descartada: true });
            t.ok(r.tomas[0].descartada);
            t.eq(r.historia.atras, 1);
        });
    });

    t.test('borrar un comentario que no existe no deja paso', async () => {
        // `descomentar` filtra, así que devuelve una lista nueva con lo mismo
        // adentro: mirar si la lista es otra diría que cambió algo cuando no.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const r = grabacion.editar({ tipo: 'borrar-comentario', toma: id, indice: 7 });
            t.eq(r.tomas[0].comentarios.length, 0);
            t.eq(r.historia.atras, 0);
        });
    });

    t.test('descartar dos veces el mismo ajuste deja un paso, no dos', async () => {
        // La marca lleva la hora en que se puso, así que reescribirla alcanzaba
        // para que la foto de después dijera que algo cambió.
        await conSesion((dir, e) => {
            const [una, dos] = e.tomas.map(x => x.id);
            grabacion.editar({ tipo: 'descartar-ajuste', toma: dos, contra: una });
            const r = grabacion.editar({ tipo: 'descartar-ajuste', toma: dos, contra: una });
            t.eq(r.historia.atras, 1);
        });
    });

    t.test('pero descartar el ajuste contra OTRA toma sí es otro cambio', async () => {
        // Con quién empalma cambia en cuanto se descarta la del medio, y entonces
        // la pregunta es otra: la marca vale para el empalme que el editor miró.
        await conSesion((dir, e) => {
            const [una, dos, tres] = e.tomas.map(x => x.id);
            grabacion.editar({ tipo: 'descartar-ajuste', toma: tres, contra: dos });
            const r = grabacion.editar({ tipo: 'descartar-ajuste', toma: tres, contra: una });
            t.eq(r.historia.atras, 2);
        });
    });

    t.test('dos comentarios iguales son dos cambios, no uno', async () => {
        // La otra punta de la regla: el portero compara las listas elemento a
        // elemento, y dos comentarios con el mismo texto son dos comentarios.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            const cuando = e.tomas[0].palabras[1].t;
            const uno = { tipo: 'comentar', toma: id, desdeMs: cuando, hastaMs: cuando, texto: 'vamos', comentario: 'acá' };
            grabacion.editar(uno);
            const r = grabacion.editar(uno);
            t.eq(r.tomas[0].comentarios.length, 2);
            t.eq(r.historia.atras, 2);
        });
    });

    /* ─── Los dos gestos que no son de ninguna toma ───────────────────────
     *
     * Poner la claqueta a mano y pegar la lista del CD también reescriben el XML
     * y el sidecar en el acto, así que también tienen que poder volver. Sin eso
     * el Cmd-Z que se da después de uno de los dos se lleva puesto el cambio
     * ANTERIOR: el editor ve moverse una toma que no había pedido tocar.
     *
     * Lo que estas pruebas fijan, además de que se deshagan, es que se deshagan
     * SIN arrastrar nada: la foto es del campo y de nada más, así que deshacer un
     * pegado de hace cinco minutos tiene que dejar donde están las tomas que
     * entraron mientras tanto.
     */
    t.group('el historial · la claqueta puesta a mano');

    t.test('poner la claqueta deja un paso, y deshacerla la saca del archivo', async () => {
        await conSesion((dir, e) => {
            const cuando = e.ceroMs + 5000;
            const puesta = grabacion.claqueta(cuando);
            t.eq(puesta.claqueta.ms, cuando);
            t.ok(puesta.claqueta.confirmada, 'la afirmó una persona');
            t.eq(puesta.historia.queAtras, 'poner la claqueta', 'el botón dice qué va a deshacer');
            t.eq(sidecarDe(dir, e).claqueta.ms, cuando, 'el archivo se escribió con ella');

            const r = grabacion.deshacer();
            t.ok(r.ok);
            t.eq(r.que, 'poner la claqueta');
            t.eq(r.estado.claqueta, null, 'volvió a no haber ninguna');
            t.eq(sidecarDe(dir, e).claqueta, null, 'y deshacer lo volvió a escribir');
        });
    });

    t.test('rehacerla la vuelve a poner, en el archivo también', async () => {
        await conSesion((dir, e) => {
            const cuando = e.ceroMs + 5000;
            grabacion.claqueta(cuando);
            grabacion.deshacer();
            const r = grabacion.rehacer();
            t.ok(r.ok);
            t.eq(r.estado.claqueta.ms, cuando);
            t.eq(sidecarDe(dir, e).claqueta.ms, cuando);
        });
    });

    t.test('poner la misma claqueta dos veces no deja un paso de más', async () => {
        await conSesion((dir, e) => {
            const cuando = e.ceroMs + 5000;
            grabacion.claqueta(cuando);
            const r = grabacion.claqueta(cuando);
            t.eq(r.historia.atras, 1);
        });
    });

    t.test('deshacerla NO toca las tomas que entraron mientras tanto', async () => {
        // La razón entera de que la foto sea del campo y no de la sesión: una
        // foto de la sesión repuesta acá se llevaría puesta la toma que llegó.
        await conSesion(async (dir, e, mas) => {
            grabacion.claqueta(e.ceroMs + 5000);
            await mas(10);
            t.eq(grabacion.resumen().tomas.length, 4, 'llegó una toma nueva');

            const r = grabacion.deshacer();
            t.ok(r.ok);
            t.eq(r.estado.claqueta, null, 'la claqueta volvió atrás');
            t.eq(r.estado.tomas.length, 4, 'y las cuatro tomas siguen ahí');
            t.eq(sidecarDe(dir, e).tomas.length, 4, 'en el archivo también');
        });
    });

    t.test('y no se planta por haber una toma abierta, que es cosa de las tomas', async () => {
        // La única cosa que no se puede deshacer es reponer una toma abierta
        // cuando ya hay otra. Un paso de la sesión no repone ninguna toma, así
        // que esa pregunta no le corresponde: hecha igual lo plantaría siempre,
        // porque un paso sin `id` hace que cualquier toma abierta cuente como
        // "la otra". Acá la toma 3 está abierta desde que arrancó la prueba.
        await conSesion((dir, e) => {
            t.eq(e.abierta, e.tomas[2].id, 'hay una toma abierta');
            grabacion.claqueta(e.ceroMs + 5000);
            t.ok(grabacion.deshacer().ok, 'se deshace');
            const r = grabacion.rehacer();
            t.ok(r.ok, 'y se rehace');
            t.eq(r.estado.claqueta.ms, e.ceroMs + 5000);
        });
    });

    t.group('el historial · el temario del CD');

    const LISTA = '- Qué es un PROM\n- Cómo se mide la cobertura';

    t.test('pegar el temario deja un paso, y deshacerlo lo saca del archivo', async () => {
        await conSesion((dir, e) => {
            const puesto = grabacion.ponerTemario(LISTA);
            t.eq(puesto.temario.objetivos.length, 2);
            t.eq(puesto.historia.queAtras, 'pegar el temario');
            t.eq(sidecarDe(dir, e).temario.objetivos.length, 2, 'el archivo lo tiene');

            const r = grabacion.deshacer();
            t.ok(r.ok);
            t.eq(r.que, 'pegar el temario');
            t.eq(r.estado.temario, null, 'volvió a no haber lista');
            t.eq(sidecarDe(dir, e).temario, null, 'y deshacer lo volvió a escribir');
        });
    });

    t.test('sacarlo también es un paso, y se llama por su nombre', async () => {
        await conSesion((dir, e) => {
            grabacion.ponerTemario(LISTA);
            const vacio = grabacion.ponerTemario('');
            t.eq(vacio.temario, null);
            t.eq(vacio.historia.queAtras, 'sacar el temario');

            const r = grabacion.deshacer();
            t.eq(r.estado.temario.objetivos.length, 2, 'la lista vuelve entera');
        });
    });

    t.test('pegar la misma lista otra vez no deja paso ni tira lo ya medido', async () => {
        // Es el gesto de quien pega dos veces por las dudas. Antes tiraba la
        // cobertura y pagaba una consulta nueva para llegar al mismo resultado.
        await conSesion(async (dir, e) => {
            grabacion.ponerTemario(LISTA);
            await respirar();
            t.ok(grabacion.resumen().temario.cobertura, 'la lista se midió');

            const r = grabacion.ponerTemario(LISTA);
            t.eq(r.historia.atras, 1, 'un solo paso');
            t.ok(r.temario.cobertura, 'y la cobertura sigue puesta');
        });
    });

    t.test('deshacer devuelve la lista anterior CON lo que se le había medido', async () => {
        // El borde que importa del temario: la foto se saca en el momento de
        // pegar la lista nueva, o sea cuando lo viejo ya estaba medido. Así
        // deshacer no cuesta una consulta ni deja el panel sin resultado.
        await conSesion(async (dir, e) => {
            grabacion.ponerTemario('- Qué es un PROM');
            await respirar();
            const primera = grabacion.resumen().temario.cobertura;
            t.ok(primera, 'la primera lista se midió');

            grabacion.ponerTemario(LISTA);
            await respirar();
            t.eq(grabacion.resumen().temario.objetivos.length, 2);

            const r = grabacion.deshacer();
            t.eq(r.estado.temario.objetivos.length, 1, 'volvió la lista de antes');
            t.ok(r.estado.temario.cobertura, 'con su cobertura, no en blanco');
            t.deep(r.estado.temario.cobertura.huella, primera.huella,
                'es la medición que era, no una nueva');
        });
    });

    t.group('el historial · una sola pila para los dos');

    t.test('el orden de deshacer es el orden en que se hicieron los gestos', async () => {
        // Con dos pilas habría que inventar cuál toca primero; con una sola, la
        // respuesta correcta —la que se tocó al final— ya está.
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'vista', toma: id, vista: 'S' });
            grabacion.claqueta(e.ceroMs + 5000);
            grabacion.ponerTemario(LISTA);
            grabacion.editar({ tipo: 'nota', toma: id, texto: 'mirar el audio' });
            t.eq(grabacion.resumen().historia.atras, 4);

            t.eq(grabacion.deshacer().que, `la nota de la toma ${id}`);
            t.eq(grabacion.deshacer().que, 'pegar el temario');
            t.eq(grabacion.deshacer().que, 'poner la claqueta');

            const ultimo = grabacion.deshacer();
            t.eq(ultimo.que, `poner la toma ${id} en S`);
            t.eq(ultimo.estado.tomas[0].vista, 'PV', 'y la toma volvió a lo que era');
            t.eq(ultimo.estado.claqueta, null);
            t.eq(ultimo.estado.temario, null);
            t.eq(ultimo.estado.historia.adelante, 4, 'los cuatro esperan para rehacerse');
        });
    });

    t.test('y rehacerlos los devuelve en el orden en que se hicieron', async () => {
        await conSesion((dir, e) => {
            const id = e.tomas[0].id;
            grabacion.editar({ tipo: 'vista', toma: id, vista: 'S' });
            grabacion.claqueta(e.ceroMs + 5000);
            grabacion.deshacer();
            grabacion.deshacer();

            t.eq(grabacion.rehacer().que, `poner la toma ${id} en S`);
            const r = grabacion.rehacer();
            t.eq(r.que, 'poner la claqueta');
            t.eq(r.estado.tomas[0].vista, 'S');
            t.eq(r.estado.claqueta.ms, e.ceroMs + 5000);
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
