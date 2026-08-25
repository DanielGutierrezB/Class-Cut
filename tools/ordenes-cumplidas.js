'use strict';
/**
 * ordenes-cumplidas.js — ¿Se está haciendo lo que el CD pidió?
 *
 * Un puñado de marcadores traen una orden escrita: `OUT ANTES DE: "…"`. No es
 * una sugerencia, es la persona que armó la clase diciendo dónde va el corte, y
 * es lo más barato de verificar que hay: se busca la frase en el transcript y se
 * mira si el borde quedó ahí.
 *
 * Se usa como módulo (lo llama `tools/banco-contexto.js` para medir una corrida
 * en memoria) y como script sobre lo que ya está en el disco:
 *
 *   node tools/ordenes-cumplidas.js "/ruta/al/curso" [--detalle]
 */

const fs = require('fs');
const path = require('path');
const ordenDelCd = require('../engine/orden-del-cd');

// Cuánto puede desviarse el borde de la frase pedida y seguir contando. Un
// segundo es aproximadamente el colchón de aire más el ajuste al ataque del
// sonido: por debajo de eso, el corte está donde el CD pidió.
const TOLERANCIA_SEC = 1.0;

/**
 * Mide el cumplimiento de una clase.
 *
 * @param {Array} blocks bloques con startSec/endSec ya decididos
 * @param {Array} words palabras del transcript
 * @returns {{total, cumplidas, lejos, sinUbicar, detalles}}
 */
function medirClase(blocks, words, options) {
    const salida = { total: 0, cumplidas: 0, lejos: 0, sinUbicar: 0, detalles: [] };

    for (let i = 0; i < (blocks || []).length; i++) {
        const block = blocks[i];
        for (const kind of ['IN', 'OUT']) {
            const orden = ordenDelCd.para(block, kind);
            if (!orden) continue;
            salida.total++;

            const ubicada = ordenDelCd.ubicar(words, orden, blocks, i, options);
            const borde = kind === 'IN' ? block.startSec : block.endSec;

            if (!ubicada) {
                salida.sinUbicar++;
                salida.detalles.push({
                    bloque: i + 1, estado: 'sin ubicar', orden,
                    texto: `«${orden.frase.slice(0, 46)}» no aparece en este tramo`
                });
                continue;
            }

            const delta = borde - ubicada.timeSec;
            if (Math.abs(delta) <= TOLERANCIA_SEC) {
                salida.cumplidas++;
                salida.detalles.push({ bloque: i + 1, estado: 'cumple', orden, texto: '' });
            } else {
                salida.lejos++;
                salida.detalles.push({
                    bloque: i + 1, estado: 'lejos', orden,
                    texto: `pedida en ${ubicada.timeSec.toFixed(1)}s, el borde quedó en ` +
                        `${borde.toFixed(1)}s (${delta > 0 ? '+' : ''}${delta.toFixed(1)}s)`
                });
            }
        }
    }
    return salida;
}

function clases(root) {
    const dir = path.join(root, 'The Cutter', 'Backup');
    if (!fs.existsSync(dir)) { console.error(`No hay Backup en ${dir}.`); process.exit(1); }
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('_align.json'))
        .sort()
        .map(file => {
            const name = file.replace(/_align\.json$/, '');
            const tp = path.join(dir, `${name}_transcript.json`);
            if (!fs.existsSync(tp)) return null;
            return {
                name,
                blocks: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).blocks || [],
                words: JSON.parse(fs.readFileSync(tp, 'utf8')).words || []
            };
        })
        .filter(Boolean);
}

module.exports = { medirClase, TOLERANCIA_SEC };

if (require.main === module) {
    const root = process.argv[2];
    if (!root) { console.error('Falta la carpeta del curso.'); process.exit(1); }
    const detalle = process.argv.includes('--detalle');

    const suma = { total: 0, cumplidas: 0, lejos: 0, sinUbicar: 0 };
    const lineas = [];
    for (const cls of clases(root)) {
        const m = medirClase(cls.blocks, cls.words, { fps: 30 });
        for (const k of Object.keys(suma)) suma[k] += m[k];
        for (const d of m.detalles) {
            if (d.estado === 'cumple' && !detalle) continue;
            lineas.push(`  ${cls.name.slice(0, 2)} b${d.bloque} ${d.orden.borde} ${d.orden.relacion}: ${d.texto || 'cumple'}`);
        }
    }

    const pct = suma.total ? Math.round((suma.cumplidas / suma.total) * 100) : 0;
    console.log(`\n${suma.total} órdenes escritas por el CD · ${suma.cumplidas} cumplidas (${pct}%)\n`);
    console.log(`  el borde quedó lejos : ${suma.lejos}`);
    console.log(`  la frase no se ubica : ${suma.sinUbicar}\n`);
    if (lineas.length) console.log(`${lineas.join('\n')}\n`);
}
