'use strict';
/**
 * variante-conector.js — La variante que se traga el conector, para probar que
 * la vara la sigue delatando.
 *
 * "Abre partiendo una frase" (`speech-edges.abreAMitad`) no existe por gusto:
 * existe porque sin él se podía MEJORAR EL NÚMERO EMPEORANDO LA CLASE. Correr
 * cada IN que abre con un conector hasta detrás de él deja `conector` en cero y
 * baja el total, y deja bloques que abren en «la sexta herramienta no es…», «por
 * muy bien que hayamos…», «si quieres comenzar a desarrollar…». Ninguna otra
 * cuenta lo ve, porque todas miran el final del bloque.
 *
 * O sea que ese renglón es un guardián, y un guardián que nadie prueba es un
 * comentario. Esto lo prueba: arma la variante sobre los planes ENTREGADOS y en
 * memoria —con `borde.aplicar`, que es la misma maquinaria que usaría el repaso,
 * o sea con la onda y el colchón de aire— y saca la tabla entera de las dos.
 *
 * **Por qué hace falta correrlo cada vez que se toca `abreAMitad`.** Se probó
 * una versión que preguntaba "¿el corte cae encima de alguien hablando?" con el
 * mapa de voz, y sobre el curso entregado daba lo correcto (1 en vez de 7). Pero
 * contra esta variante daba 2 de 15: `audio-onset` pone el corte SIEMPRE del
 * lado del silencio, así que "cae encima de alguien hablando" es casi
 * imposible para un corte que puso el motor. La pregunta que sí funciona es la
 * otra —¿sonó alguien entre donde el transcript pone la palabra de antes y el
 * corte?— y solo se ve la diferencia acá.
 *
 *   node tools/variante-conector.js "/ruta/al/curso"
 */

const fs = require('fs');
const path = require('path');

const edges = require('../engine/speech-edges');
const reloj = require('../engine/reloj');
const borde = require('../engine/borde');
const onset = require('../engine/vendor/audio-onset');
const scanner = require('../engine/course-scan');
const defectos = require('./defectos');

const root = process.argv[2];
if (!root) {
    console.error('Falta la carpeta del curso.');
    process.exit(1);
}

const dir = path.join(root, 'The Cutter', 'Backup');
if (!fs.existsSync(dir)) {
    console.error(`No hay Backup en ${dir}. Procesá el curso primero.`);
    process.exit(1);
}

const scan = scanner.scan(root);
const wavDe = {};
for (const cls of (scan.ok ? scan.classes : [])) wavDe[cls.sequenceName] = cls.liveMixPath;

/**
 * Las clases del Backup, releídas cada vez.
 *
 * Cada brazo se arma sobre su propia copia: `borde.aplicar` escribe encima del
 * bloque, y compartir los objetos sería medir la variante contra sí misma. Es la
 * misma regla de siempre — las entradas se congelan antes de comparar.
 */
function clases() {
    return fs.readdirSync(dir).filter(f => f.endsWith('_align.json')).sort().map(file => {
        const name = file.replace(/_align\.json$/, '');
        const transcriptPath = path.join(dir, `${name}_transcript.json`);
        if (!fs.existsSync(transcriptPath)) return null;
        const align = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const crudas = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')).words || [];
        const vozPath = path.join(dir, `${name}_voz.json`);
        const wavPath = wavDe[name];
        const info = wavPath ? onset.wavInfo(wavPath) : null;
        return {
            name,
            align,
            words: reloj.paraDecidir(crudas, align.reloj === 'dtw' ? 'auto' : 'crudo').palabras,
            voz: fs.existsSync(vozPath) ? JSON.parse(fs.readFileSync(vozPath, 'utf8')) : null,
            wav: info ? { file: wavPath, info } : null
        };
    }).filter(Boolean);
}

function tabla(lista, titulo) {
    const cuenta = Object.fromEntries(defectos.TIPOS.map(t => [t, 0]));
    const ejemplos = [];
    let sinVoz = 0;
    for (const cls of lista) {
        const medido = defectos.contarClase(cls.words, cls.align.blocks, cls.voz);
        for (const tipo of defectos.TIPOS) cuenta[tipo] += medido.cuenta[tipo];
        sinVoz += medido.sinVoz;
        for (const e of medido.ejemplos) {
            ejemplos.push(`  clase ${cls.name.slice(0, 2)} bloque ${e.bloque} · ${e.tipo}: ${e.texto}`);
        }
    }
    const total = defectos.TIPOS.reduce((n, t) => n + cuenta[t], 0);
    console.log(`\n${titulo}`);
    console.log(`  ${defectos.TIPOS.map(t => `${t}=${cuenta[t]}`).join(' · ')}`);
    console.log(`  TOTAL ${total}${sinVoz ? `   ⚠ ${sinVoz} bloques sin mapa de voz` : ''}`);
    return { cuenta, total, ejemplos };
}

const antes = tabla(clases(), 'ENTREGADO · los planes tal como están');

const variante = clases();
let movidos = 0;
for (const cls of variante) {
    for (const block of (cls.align.blocks || []).filter(b => b.enabled !== false)) {
        const dentro = edges.wordsInside(cls.words, block.startSec, block.endSec);
        const largo = edges.largoDeConector(dentro.slice(0, 2));
        if (!largo || largo >= dentro.length) continue;
        borde.aplicar({
            block, kind: 'IN', timeSec: dentro[largo].start,
            words: cls.words, wav: cls.wav, options: null, decidedBy: 'variante'
        });
        movidos++;
    }
}
const despues = tabla(variante, `VARIANTE · el IN detrás del conector (${movidos} IN movidos)`);

console.log('\nlo que la variante deja abriendo partiendo una frase:');
const abriendo = despues.ejemplos.filter(l => l.includes('· abriendo:'));
console.log(abriendo.length ? abriendo.join('\n') : '  (ninguno)');

// El guardián sirve si la variante PAGA, o sea si el total empeora. No se le
// pide un defecto por cada IN movido, y eso costó entenderlo: mover el IN detrás
// del conector casi nunca quita el conector. `speech-edges.wordLimits` no deja
// que el corte pase del final que el transcript le da a la palabra de antes, y
// en el reloj del DTW ese final cae ANTES del sonido — así que el corte se queda
// del lado de acá y el conector se sigue oyendo. Medido cortando el Live-Mix por
// el borde nuevo y transcribiendo ese pedazo, en 11 de los 15 el bloque sigue
// abriendo con «Y la sexta herramienta…», «Pero antes de abrir la terminal…»,
// «También nos está dando…». Solo 4 lo pierden de verdad, y esta vara marca
// exactamente esos: 15 de 15 de acuerdo con lo que se oye.
const delatada = despues.total > antes.total;
console.log(`\n${delatada ? '✓' : '✗'} el guardián ${delatada ? 'delata' : 'NO delata'} la variante: ` +
    `${movidos} IN movidos · abriendo ${antes.cuenta.abriendo} → ${despues.cuenta.abriendo} ` +
    `· TOTAL ${antes.total} → ${despues.total}`);
process.exit(delatada ? 0 : 1);
