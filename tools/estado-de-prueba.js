'use strict';
/**
 * estado-de-prueba.js — Un estado de grabación de mentira, para el arnés.
 *
 * `dev.grabarEstado()` dibuja la lista de tomas con lo que se le dé, y armar ese
 * objeto a mano dentro de un `--js` es ilegible. Acá sale ya hecho, con lo que
 * hace falta mirar: orillas de los dos lados, una toma abierta, una descartada y
 * un comentario puesto.
 *
 *   node -e "console.log(require('./tools/estado-de-prueba')())"
 *
 * Con `muestrario()` sale otro: una toma por cada vista y nada más, para mirar
 * los cinco colores uno debajo del otro y aprobarlos. Se arma desde `VISTAS`, así
 * que una vista nueva aparece sola.
 */

const vivo = require('../engine/notas-vivo');
const workspace = require('../engine/workspace');

const BASE = Date.UTC(2026, 8, 8, 18, 0, 0);
const DIR = '/tmp/notas';

/** Una palabra por segundo, para poder contar de un vistazo. */
function palabras(desdeMs, lista) {
    return lista.map((texto, i) => ({ t: desdeMs + i * 1000, texto }));
}

function estado() {
    return {
        secuencia: '02_curso_2026-09-08_15-00-00',
        clase: 2,
        parte: 1,
        curso: 'curso-de-prueba',
        ceroMs: BASE,
        claqueta: { ms: BASE + 5000, confirmada: true },
        vistas: vivo.VISTAS,
        dir: DIR,
        // Armados con `workspace` y no escritos a mano: el cartel de "se guarda
        // en" es justo lo que se mira acá, y con la ruta inventada el arnés
        // aprobaría una forma de carpeta que la app no usa.
        archivos: workspace.notasArchivos(DIR, '02_curso_2026-09-08_15-00-00'),
        grabando: true,
        terminando: false,
        segundos: 300,
        abierta: 3,
        tomas: [
            {
                id: 1, vista: 'PV', comentario: 'Repite el arranque', descartada: false,
                cerradaSola: false, pausaAdentro: null, repiteA: null, cuenta: '3, 2, 1.',
                inMs: BASE + 20000, outMs: BASE + 30000,
                antes: palabras(BASE + 14000, ['esto', 'es', 'la', 'orilla', 'de', 'antes']),
                palabras: palabras(BASE + 20000, ['Hoy', 'vamos', 'a', 'ver', 'qué', 'es', 'una', 'spec', 'de', 'verdad']),
                despues: palabras(BASE + 30000, ['y', 'esto', 'es', 'la', 'orilla', 'de', 'después']),
                // Dos, y en la misma toma: con uno solo el subrayado se explica
                // solo, y lo que hay que poder mirar es si se distingue cuál es
                // cuál cuando hay varios sobre el mismo texto.
                comentarios: [{
                    desdeMs: BASE + 23000, hastaMs: BASE + 27000,
                    texto: 'ver qué es una spec', comentario: 'Cortar justo antes de esto'
                }, {
                    desdeMs: BASE + 20000, hastaMs: BASE + 22000,
                    texto: 'Hoy vamos a', comentario: 'Entra muy de golpe, dejar aire'
                }]
            },
            {
                id: 2, vista: 'S', comentario: '', descartada: true,
                cerradaSola: false, pausaAdentro: null, repiteA: 1, cuenta: '3, 2, 1.',
                inMs: BASE + 40000, outMs: BASE + 46000,
                antes: [], palabras: palabras(BASE + 40000, ['Hoy', 'vamos', 'a', 'ver']), despues: [],
                comentarios: []
            },
            {
                id: 3, vista: 'R', comentario: '', descartada: false,
                cerradaSola: false, pausaAdentro: null, repiteA: null, cuenta: 'Tres, dos, uno.',
                inMs: BASE + 60000, outMs: null,
                antes: palabras(BASE + 54000, ['retomamos', 'desde', 'acá']),
                palabras: palabras(BASE + 60000, ['Una', 'spec', 'es', 'un', 'documento', 'que', 'se', 'mantiene']),
                despues: [],
                // En la toma abierta y en la vista de pantalla, que es el color
                // más claro de los cinco: es donde el subrayado tiene que seguir
                // viéndose y donde la tinta de la cabecera se pone a prueba.
                comentarios: [{
                    desdeMs: BASE + 64000, hastaMs: BASE + 67000,
                    texto: 'documento que se mantiene', comentario: 'Repetir esta frase al cierre'
                }]
            }
        ]
    };
}

/**
 * La paleta entera: una toma por vista, en el orden en que se ofrecen.
 *
 * Cada tarjeta lleva su nombre y su título escritos en la nota, y todas llevan
 * texto y un comentario subrayado: el color de la tarjeta hay que juzgarlo con
 * algo encima, que es cómo se va a ver. Ninguna descartada y ninguna abierta,
 * para que las cinco se dibujen iguales y lo único que cambie sea el color.
 */
function muestrario() {
    const arranque = BASE + 20000;
    return {
        ...estado(),
        secuencia: 'muestrario_de_colores',
        abierta: null,
        // Las vistas al revés a propósito: `pintar` dibuja la lista de la última
        // toma a la primera —lo que importa mirar es lo que está pasando—, así que
        // para que la paleta se lea de arriba abajo en el mismo orden que el
        // selector, la primera vista tiene que ser la última toma. Sin esto había
        // que comparar la pantalla con el selector leyendo una de las dos al
        // revés, que es justo lo que se está por aprobar.
        tomas: [...vivo.VISTAS].reverse().map((v, i) => {
            const inMs = arranque + i * 20000;
            const dichas = ['Así', 'se', 've', 'la', 'vista', v.nombre, 'con', 'texto', 'encima'];
            return {
                id: i + 1,
                vista: v.nombre,
                comentario: `${v.nombre} · ${v.titulo}`,
                descartada: false,
                cerradaSola: false,
                pausaAdentro: null,
                repiteA: null,
                cuenta: '3, 2, 1.',
                inMs,
                outMs: inMs + 10000,
                antes: palabras(inMs - 3000, ['tres,', 'dos,', 'uno.']),
                palabras: palabras(inMs, dichas),
                despues: palabras(inMs + 10000, ['Pausa.']),
                comentarios: [{
                    desdeMs: inMs + 4000, hastaMs: inMs + 8000,
                    texto: `vista ${v.nombre} con texto`,
                    comentario: 'Un comentario, para ver el subrayado sobre este color'
                }]
            };
        })
    };
}

module.exports = estado;
module.exports.muestrario = muestrario;
