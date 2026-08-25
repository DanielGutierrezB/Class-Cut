'use strict';
/**
 * medir-repeticiones.js — Qué se dice dos veces y qué se puede arreglar solo.
 *
 * Corre la detección sobre un curso ya procesado y muestra, para cada
 * repetición, con qué se queda el bloque y qué se va. La idea es poder leer las
 * dos puntas antes de dejar que la herramienta las toque: un recorte mal puesto
 * se lee enseguida, y así se calibran los umbrales mirando material real en vez
 * de a ojo.
 *
 *   node tools/medir-repeticiones.js "/ruta/al/curso" [--todas]
 */

const fs = require('fs');
const path = require('path');
const repeticiones = require('../engine/repeticiones');
const speech = require('../engine/speech-edges');

const root = process.argv[2];
if (!root) { console.error('Falta la carpeta del curso.'); process.exit(1); }

const dir = path.join(root, 'The Cutter', 'Backup');
if (!fs.existsSync(dir)) { console.error(`No hay Backup en ${dir}.`); process.exit(1); }

const suma = { clases: 0, encontradas: 0, recortar: 0, avisar: 0, segundos: 0 };

for (const file of fs.readdirSync(dir).filter(f => f.endsWith('_align.json')).sort()) {
    const name = file.replace(/_align\.json$/, '');
    const tp = path.join(dir, `${name}_transcript.json`);
    if (!fs.existsSync(tp)) continue;

    const blocks = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).blocks || [];
    const words = JSON.parse(fs.readFileSync(tp, 'utf8')).words || [];
    suma.clases++;

    for (const h of repeticiones.buscar(words, blocks, { fps: 30 })) {
        suma.encontradas++;
        if (h.accion === 'recortar') { suma.recortar++; suma.segundos += h.recorteSec; }
        else suma.avisar++;

        const block = blocks.find(b => b.index === h.bloque);
        // Lo que se lee acá tiene que ser lo que va a quedar de verdad, con el
        // borde ya limpio: si se muestra el punto crudo, un recorte que termina
        // en "Pausa. 3, 2," parece bueno en la medición y malo en la clase.
        const copia = JSON.parse(JSON.stringify(block));
        const fin = h.accion === 'recortar'
            ? repeticiones.recortar(copia, h.timeSec, { words, wav: null, options: { fps: 30 } })
            : block.endSec;
        const queda = speech.textInside(words, Math.max(block.startSec, fin - 11), fin);

        console.log(`\n── ${name.slice(0, 2)} · bloque ${h.bloque + 1} contra ${h.contra + 1} · ${h.accion}` +
            ` · sobran ${h.recorteSec}s (dicen lo mismo ${Math.round(h.parecido * 100)}%)`);
        console.log(`   se queda : …${queda.slice(-88)}`);
        console.log(`   se va    : ${h.texto.slice(0, 88)}…`);
    }
}

console.log(`\n${suma.clases} clases · ${suma.encontradas} repeticiones` +
    ` · ${suma.recortar} se recortan (${Math.round(suma.segundos)}s)` +
    ` · ${suma.avisar} hay que mirarlas\n`);
