'use strict';
/**
 * Que todo lo que la ventana carga sea un módulo ES válido.
 *
 * Parece de más y no lo es: un choque de nombres entre un `import` y algo que ya
 * existía en el archivo —lo que pasó importando `guardar` de `comentarios.js` a
 * un `onda-clase.js` que ya tenía el suyo— **no rompe nada visible**. La ventana
 * abre, el fondo se dibuja, no aparece ningún cartel; simplemente ningún módulo
 * llega a correr y la app queda inerte. El error va a la consola del renderer,
 * que nadie mira.
 *
 * Y no lo agarra `node --check`, que es lo primero que uno prueba: parsea como
 * script clásico, donde declarar dos veces el mismo nombre con `function` es
 * legal. Recién parseando como MÓDULO —que es como los carga la ventana— salta.
 *
 * Es estático a propósito: importarlos de verdad los haría ejecutarse, y todos
 * hablan con el DOM.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', 'src', 'js');

function modulos(dir) {
    const salida = [];
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        const completo = path.join(dir, entrada.name);
        if (entrada.isDirectory()) salida.push(...modulos(completo));
        else if (entrada.name.endsWith('.js')) salida.push(completo);
    }
    return salida;
}

/** @returns {string|null} el error, o null si parsea */
function revisar(archivo) {
    try {
        execFileSync(process.execPath, ['--input-type=module', '--check'], {
            input: fs.readFileSync(archivo, 'utf8'),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return null;
    } catch (e) {
        const linea = String(e.stderr || '').split('\n').find(l => /Error/.test(l));
        return linea ? linea.trim() : 'no parsea como módulo';
    }
}

module.exports = t => {
    t.group('la ventana · todo lo que se carga parsea como módulo');

    const lista = modulos(RAIZ);

    t.test('hay módulos que revisar', () => {
        // Si la carpeta se mueve, esta prueba pasaría en verde sin mirar nada.
        t.eq(lista.length > 15, true, `encontrados ${lista.length}`);
    });

    t.test('ninguno tiene un choque de nombres ni sintaxis inválida', () => {
        const rotos = lista
            .map(f => ({ f: path.relative(RAIZ, f), error: revisar(f) }))
            .filter(x => x.error);
        t.eq(rotos.length, 0, rotos.map(x => `${x.f}: ${x.error}`).join(' · ') || 'todos parsean');
    });

    t.test('y la prueba sabe fallar', () => {
        // Sin esto, un cambio que deje de revisar de verdad pasaría en verde para
        // siempre: es la misma trampa que el chequeo que quiere atrapar.
        const roto = path.join(require('os').tmpdir(), `cc-modulo-roto-${process.pid}.js`);
        fs.writeFileSync(roto, 'import { x } from "./a.js";\nconst x = 1;\n');
        try {
            t.eq(typeof revisar(roto), 'string', 'un nombre repetido se detecta');
        } finally {
            fs.unlinkSync(roto);
        }
    });
};
