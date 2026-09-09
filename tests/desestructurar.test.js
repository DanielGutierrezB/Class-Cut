'use strict';
/**
 * Que lo que un módulo del motor saca de otro exista de verdad.
 *
 * `const { CLASE_MARKER } = require('./prproj-moldes')` con un
 * `prproj-moldes` que no lo exporta **no tira nada**: la constante queda
 * `undefined` y sigue de largo. Recién se nota mucho después y en otro lado,
 * cuando ese valor se escribe en un archivo. Eso fue exactamente lo que pasó
 * partiendo `prproj-secuencia.js` en dos: quedaron dos bloques `module.exports`
 * pegados, el segundo pisó al primero y se comió dos GUID, y cada marcador de
 * cada proyecto generado salió con `ClassID="undefined"`. El archivo se escribía
 * entero, la verificación del grafo lo daba por bueno y ninguna prueba lo veía.
 *
 * Es de las fallas más baratas de prevenir y más caras de encontrar: no hay
 * excepción, no hay línea que mirar, y el síntoma aparece en Premiere.
 *
 * Se mira el texto y no se ejecuta nada: importar los módulos de verdad los haría
 * correr, y varios hablan con el disco al cargarse.
 */

const fs = require('fs');
const path = require('path');

const MOTOR = path.join(__dirname, '..', 'engine');

/**
 * Los `const { a, b } = require('./otro')` de un archivo.
 *
 * Solo los relativos: de `fs` o `path` no opinamos, y un paquete de `node_modules`
 * puede exportar de maneras que esto no sabe leer.
 */
function loQueSaca(texto) {
    const sacadas = [];
    const re = /const\s*\{([^}]*)\}\s*=\s*require\(\s*'(\.[^']+)'\s*\)/g;
    let m;
    while ((m = re.exec(texto))) {
        const nombres = m[1]
            .split(',')
            .map(s => s.trim().split(':')[0].trim())
            .filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
        if (nombres.length) sacadas.push({ de: m[2], nombres });
    }
    return sacadas;
}

module.exports = t => {

    t.group('el motor · lo que un módulo le saca a otro');

    t.test('todo lo desestructurado existe del otro lado', () => {
        const archivos = fs.readdirSync(MOTOR).filter(n => n.endsWith('.js'));
        let revisadas = 0;

        for (const archivo of archivos) {
            const texto = fs.readFileSync(path.join(MOTOR, archivo), 'utf8');
            for (const { de, nombres } of loQueSaca(texto)) {
                let otro;
                try {
                    otro = require(path.join(MOTOR, de));
                } catch (e) {
                    // Un módulo que no carga es problema de otra prueba; acá lo
                    // que se mira es qué exporta, y de uno que no carga no se
                    // puede saber. Callarlo sería peor: se dice y se sigue.
                    t.ok(false, `${archivo}: no pude cargar ${de} (${e.message})`);
                    continue;
                }
                for (const nombre of nombres) {
                    revisadas++;
                    t.ok(Object.prototype.hasOwnProperty.call(otro, nombre),
                        `${archivo} saca «${nombre}» de ${de}, y ${de} lo exporta`);
                }
            }
        }

        // Un piso, porque el riesgo de una prueba que lee texto es que un día el
        // patrón deje de encontrar nada y pase en verde sin haber mirado.
        t.ok(revisadas >= 20, `y se revisaron unas cuantas: ${revisadas}`);
    });

    t.test('ningún módulo del motor tiene dos module.exports', () => {
        // El que pisa al otro no se ve leyendo por arriba —los dos parecen «el»
        // export— y la diferencia entre uno y otro puede ser una sola línea.
        for (const archivo of fs.readdirSync(MOTOR).filter(n => n.endsWith('.js'))) {
            const texto = fs.readFileSync(path.join(MOTOR, archivo), 'utf8');
            const cuantos = (texto.match(/^module\.exports\s*=|;module\.exports\s*=/gm) || []).length;
            t.ok(cuantos <= 1, `${archivo} asigna module.exports ${cuantos} vez/veces`);
        }
    });
};
