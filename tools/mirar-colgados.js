'use strict';
/**
 * mirar-colgados.js — De los bloques que quedan mal, ¿de quién es la culpa?
 *
 * Un bloque que termina a mitad de frase puede fallar por dos motivos muy
 * distintos, y se arreglan en lugares opuestos:
 *
 *   - el corte bueno ESTABA en la lista de candidatos y no se eligió → el
 *     problema es de criterio: prompt, contexto o modelo;
 *   - el corte bueno NO ESTABA en la lista → el problema es de generación de
 *     candidatos, y ahí no hay modelo ni contexto que ayude, porque la opción
 *     correcta nunca se le ofreció.
 *
 * Sin separar esas dos cosas, cualquier medición sobre el prompt mide en parte
 * un techo que el prompt no puede mover.
 *
 *   node tools/mirar-colgados.js /ruta/al/curso
 */

const fs = require('fs');
const path = require('path');
const speech = require('../engine/speech-edges');
const precision = require('../engine/vendor/marker-precision');
const refine = require('../engine/cut-refine');
const defectos = require('./defectos');

const root = process.argv[2];
if (!root) {
    console.error('Falta la carpeta del curso.');
    process.exit(1);
}

const OPCIONES = { fps: 30, padFrames: 10, windowSec: 18, maxCandidates: 10 };

function clases() {
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
                align: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')),
                words: JSON.parse(fs.readFileSync(tp, 'utf8')).words || []
            };
        })
        .filter(Boolean);
}

/** Los candidatos que se le habrían ofrecido a ese borde, con el mismo código. */
function candidatosDe(words, block, kind) {
    const at = kind === 'IN' ? block.startSec : block.endSec;
    const cue = kind === 'IN' ? block.cueIn : block.cueOut;
    const raw = precision.buildCandidates(words, at, kind, {
        ...OPCIONES,
        cueTimes: refine.cueTimesFor(words, cue, kind, OPCIONES)
    });
    const built = refine.withSentenceCandidates(raw, words, at, kind, OPCIONES);
    return (built.candidates || [])
        .filter(c => !refine.dropsChatter(c, words, kind))
        .filter(c => refine.fitsInBlock(c, block, kind, OPCIONES));
}

/** ¿Alguno de esos candidatos habría cerrado la frase? */
function habriaCerrado(candidatos, words) {
    const hablado = speech.spoken(words);
    return candidatos.filter(c => {
        const antes = hablado.filter(w => w.end <= c.frontier + 0.02).pop();
        return antes && speech.endsSentence(antes);
    });
}

/** Qué pasó con ese borde: nadie lo miró, lo decidió la regla, o el modelo. */
function quienLoDecidio(block) {
    // `refine` solo existe si `needsCriterion` dejó pasar el bloque. Que falte no
    // quiere decir "lo decidió la regla": quiere decir que no se lo miró nunca, y
    // confundir las dos cosas es lo que hacía parecer que la regla elegía mal.
    if (!block.out || !block.out.refine) return 'ni se miró';
    return block.out.refine.decidedBy || 'regla';
}

const cuenta = { total: 0, ofrecido: 0, noOfrecido: 0 };
const porQuien = {};
const arreglables = [];
const ejemplos = [];

for (const cls of clases()) {
    let anterior = null;
    for (const block of cls.align.blocks || []) {
        const fallas = defectos.revisarBloque(cls.words, block, anterior);
        anterior = block;
        if (!fallas.some(([tipo]) => tipo === 'colgando')) continue;
        cuenta.total++;

        const candidatos = candidatosDe(cls.words, block, 'OUT');
        const buenos = habriaCerrado(candidatos, cls.words);
        const dentro = speech.wordsInside(cls.words, block.startSec, block.endSec);
        const cola = dentro.slice(-6).map(speech.textOf).join(' ');
        const quien = quienLoDecidio(block);
        porQuien[quien] = (porQuien[quien] || 0) + 1;

        if (!buenos.length) {
            cuenta.noOfrecido++;
            ejemplos.push(`  clase ${cls.name.slice(0, 2)} bloque ${block.index + 1}: NO SE OFRECÍA ` +
                `· ${quien}\n      quedó: …${cola}`);
            continue;
        }

        cuenta.ofrecido++;

        // ¿La regla sola, sin modelo, habría elegido uno de los que cierran? Es
        // la cuenta que dice cuánto se arregla con solo dejar pasar el bloque.
        const puntuados = candidatos
            .map(c => ({ c, s: refine.scoreCandidate(c, cls.words, 'OUT', block.endSec) }))
            .sort((a, b) => b.s - a.s);
        const ganaUnoBueno = buenos.some(b => b.frontier === puntuados[0].c.frontier);
        if (quien === 'ni se miró' && ganaUnoBueno) arreglables.push(`clase ${cls.name.slice(0, 2)} b${block.index + 1}`);

        ejemplos.push(`  clase ${cls.name.slice(0, 2)} bloque ${block.index + 1}: SE OFRECÍA ` +
            `(${buenos.length}/${candidatos.length} cierran) · ${quien}` +
            `${ganaUnoBueno ? ' · la regla habría acertado' : ''}\n      quedó: …${cola}`);
    }
}

console.log(`\n${cuenta.total} bloques terminan a mitad de frase\n`);
console.log(`  el corte bueno estaba en la lista : ${cuenta.ofrecido}`);
console.log(`  el corte bueno nunca se ofreció   : ${cuenta.noOfrecido}\n`);
console.log('  quién decidió ese borde:');
for (const [quien, n] of Object.entries(porQuien).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${quien.padEnd(12)} ${n}`);
}
console.log(`\n  se arreglarían solo con dejar pasar el bloque al afinado: ${arreglables.length}`);
if (arreglables.length) console.log(`    ${arreglables.join(', ')}`);
console.log(`\n${ejemplos.join('\n')}\n`);
