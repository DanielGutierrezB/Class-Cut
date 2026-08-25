'use strict';
/**
 * Las variables de las hojas de estilo: que todas las que se usan existan.
 *
 * Esto está por un fallo que pasó DOS veces sin que nadie lo viera. `visor.css`
 * pedía `var(--dim)` y `var(--fg)`; `style.css`, `var(--line)` y
 * `var(--line-strong)`. Ninguna de las cuatro estuvo definida nunca.
 *
 * Y no rompe nada, que es lo que lo hace invisible: una `var()` sin definir
 * invalida la declaración y la propiedad se queda en su valor inicial. Para un
 * color eso es heredar del padre, y para `border-color` es `currentColor` — así
 * que las tarjetas de Ajustes venían con un borde casi blanco y el texto de
 * invitación del panel de letra se veía igual de brillante que el contenido.
 * Mirándolo en pantalla parece una decisión de diseño discutible, no un error.
 *
 * Un ojo no lo distingue. Esto sí, y en el momento de escribirlo.
 *
 * Sobre el respaldo: `var(--x, #fff)` con `--x` sin definir **no falla**, y a
 * propósito. El respaldo es la declaración explícita de qué pasa si no está, así
 * que ahí no hay nada silencioso: el autor ya dijo qué quiere. Es también la
 * salida para las variables que se ponen desde el JS (`style.setProperty`), que
 * una lectura estática no puede ver — si le das respaldo, además degrada bien.
 */

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'src', 'css');

/** Todas las hojas, sin lista escrita a mano: las de mañana entran solas. */
function hojas() {
    return fs.readdirSync(CSS_DIR)
        .filter(f => f.endsWith('.css'))
        .sort()
        .map(f => ({ nombre: f, texto: fs.readFileSync(path.join(CSS_DIR, f), 'utf8') }));
}

/**
 * Una definición es `--x:` — el nombre con su dos puntos detrás. Los usos nunca
 * lo llevan (`var(--x)`, `var(--x, algo)`), así que el mismo barrido no los
 * confunde.
 */
function definidas(texto) {
    return [...texto.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]);
}

/**
 * Cada `var()` con su nombre, de qué hoja salió, en qué línea, y si trae
 * respaldo — que es lo único que decide si estar sin definir es legítimo.
 */
function usos(nombre, texto) {
    const lista = [];
    for (const m of texto.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,?)/gi)) {
        lista.push({
            variable: m[1],
            hoja: nombre,
            linea: texto.slice(0, m.index).split('\n').length,
            conRespaldo: m[2] === ','
        });
    }
    return lista;
}

/**
 * El barrido junta TODAS las hojas antes de comparar: la paleta vive en
 * `style.css` y `visor.css` la usa, así que mirar un archivo solo daría falsos
 * positivos en cada línea.
 */
function barrido() {
    const css = hojas();
    const declaradas = new Set();
    const todos = [];
    for (const { nombre, texto } of css) {
        for (const v of definidas(texto)) declaradas.add(v);
        todos.push(...usos(nombre, texto));
    }
    const huerfanas = todos.filter(u => !u.conRespaldo && !declaradas.has(u.variable));
    const usadas = new Set(todos.map(u => u.variable));
    return {
        hojas: css.map(c => c.nombre),
        declaradas,
        usos: todos,
        huerfanas,
        sinUsar: [...declaradas].filter(v => !usadas.has(v)).sort()
    };
}

module.exports = function (t) {
    t.group('estilos · las variables que se usan tienen que existir');

    t.test('el barrido lee todas las hojas y encuentra variables', () => {
        const r = barrido();
        t.ok(r.hojas.length >= 2, `hojas leídas: ${r.hojas.join(', ')}`);
        t.ok(r.declaradas.size > 10, `${r.declaradas.size} variables declaradas`);
        t.ok(r.usos.length > 50, `${r.usos.length} usos de var()`);
    });

    t.test('ninguna var() sin respaldo apunta a una variable que no existe', () => {
        const { huerfanas } = barrido();
        const detalle = huerfanas
            .map(u => `${u.hoja}:${u.linea} → ${u.variable}`)
            .join('\n      ');
        t.eq(huerfanas.length, 0, `variables usadas sin definir:\n      ${detalle}`);
    });

    t.test('una var() con respaldo puede no estar definida', () => {
        // Es el caso de `var(--cam, var(--accent))`: `--cam` la ponen las clases
        // de cámara y cuando no hay, el respaldo manda. Nada silencioso.
        const declaradas = new Set(['--accent']);
        const conRespaldo = usos('prueba.css', '.x { color: var(--sin-definir, var(--accent)); }');
        t.eq(conRespaldo.length, 2, 'se ven las dos, la de afuera y la del respaldo');
        t.eq(conRespaldo[0].conRespaldo, true);
        t.eq(conRespaldo.filter(u => !u.conRespaldo && !declaradas.has(u.variable)).length, 0);
    });

    t.test('sin respaldo y sin definir es lo que tiene que cazar', () => {
        // Los cuatro casos reales que se colaron, en su forma original.
        const texto = ':root { --border: #2c313b; }\n'
            + '.aj-tarjeta { border: 1px solid var(--line); }\n'
            + '.letra-nota { color: var(--fg); }\n'
            + '.ok { border-color: var(--border); }';
        const declaradas = new Set(definidas(texto));
        const huerfanas = usos('prueba.css', texto)
            .filter(u => !u.conRespaldo && !declaradas.has(u.variable));
        t.deep(huerfanas.map(u => u.variable), ['--line', '--fg']);
        t.eq(huerfanas[0].linea, 2, 'con la línea, para poder ir a arreglarlo');
    });

    t.test('una variable declarada que nadie usa no es un error', () => {
        // Puede ser de la paleta, puesta para tenerla. No se falla por eso; si
        // alguna vez sobra de verdad, se ve en el informe y se saca a mano.
        const r = barrido();
        t.ok(Array.isArray(r.sinUsar), `declaradas sin usar: ${r.sinUsar.join(', ') || 'ninguna'}`);
    });
};
