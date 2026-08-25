'use strict';
/**
 * contar-patrones.js — Los dos casos que quedaron sin decidir, contados.
 *
 * No arregla nada ni propone nada: cuenta. Existe porque los dos cambios que
 * quedaron pendientes tras rehacer la clase 6 tocan el comportamiento de TODO
 * el curso y se apoyaban cada uno en UNA muestra, que es exactamente la
 * cantidad de evidencia con la que no hay que tocar el corte de trece clases.
 *
 * 1. **El "Pausa." que sobrevive dentro de un bloque.** En el bloque 8 de la
 *    clase 6 el profesor repite la frase, los tiempos de Whisper están corridos
 *    en esa zona, y el bloque queda con 1,46 s de relleno y una orden al editor
 *    adentro. El arreglo estaría en el puntaje de candidatos de `cut-refine`.
 *    La pregunta que contesta esta cuenta es si el patrón es sistemático o si
 *    era esa clase: se buscan bloques con una orden al editor DENTRO —ni al
 *    principio ni al final, que es lo que `trimChatter` ya se lleva— y se
 *    informa cuánto aire tienen las dos puntas, que es lo que la deja entrar.
 *
 * 2. **La onda contra el transcript.** Hoy el borde lo decide el transcript y
 *    la onda solo informa: `borde.aplicar` mueve el corte al borde de sonido
 *    que mide la onda, pero acotado por los límites de palabra que salen del
 *    transcript, así que cuando los dos no coinciden gana el transcript y la
 *    onda deja su queja escrita en `edge.audio.code`. En los dos casos de la
 *    clase 6 la onda tenía razón. Acá se cuenta en cuántos bordes del curso
 *    pasa y de qué tamaño es el desacuerdo, para poder decidirlo con datos.
 *
 *   node tools/contar-patrones.js "/ruta/al/curso" [--detalle]
 */

const fs = require('fs');
const path = require('path');

const edges = require('../engine/speech-edges');

const root = process.argv[2];
const detalle = process.argv.includes('--detalle');

if (!root) {
    console.error('Falta la carpeta del curso.');
    process.exit(1);
}

// El colchón que pide toda la maquinaria. El desacuerdo se mide contra esto y
// no contra cero: un borde con diez frames de aire es un borde bien puesto.
const COLCHON = 10;

// A partir de cuántos frames de diferencia con el colchón vale llamarlo
// desacuerdo. Medio segundo a 30 fps: por debajo de eso la onda y el transcript
// están discutiendo por menos de lo que dura un parpadeo, y eso no es una
// contradicción, es la precisión del detector.
const DESACUERDO = 15;

function clases() {
    const dir = path.join(root, 'The Cutter', 'Backup');
    if (!fs.existsSync(dir)) {
        console.error(`No hay Backup en ${dir}.`);
        process.exit(1);
    }
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('_align.json'))
        .sort()
        .map(file => {
            const name = file.replace(/_align\.json$/, '');
            const t = path.join(dir, `${name}_transcript.json`);
            if (!fs.existsSync(t)) return null;
            return {
                numero: name.slice(0, 2),
                align: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')),
                words: JSON.parse(fs.readFileSync(t, 'utf8')).words || []
            };
        })
        .filter(Boolean);
}

function aire(edge) {
    const a = edge && edge.audio && edge.audio.airFrames;
    return typeof a === 'number' ? a : null;
}

const ordenes = [];
const desacuerdos = [];
const sinMedida = [];
let bloques = 0;
let bordes = 0;

for (const cls of clases()) {
    for (const block of (cls.align.blocks || []).filter(b => b.enabled !== false)) {
        bloques++;
        const dentro = edges.wordsInside(cls.words, block.startSec, block.endSec);

        // Las puntas se excluyen porque una orden ahí es otro defecto —el que
        // `trimChatter` quita y `medir-cortes` cuenta como `chatter`— y
        // mezclarlos daría un número que no sirve para decidir nada.
        for (let i = 1; i < dentro.length - 1; i++) {
            const texto = edges.textOf(dentro[i]).trim();
            if (!edges.STRONG_CHATTER.test(texto)) continue;
            // Y tiene que venir SUELTA, cerrando su propia frase, que es el
            // mismo criterio con el que `isChatter` distingue las palabras
            // débiles. Sin esto la cuenta se llena de casos que no son órdenes:
            // en la clase 12, «el artefacto más alto que toca» dos veces, y en
            // la 2, «Pausa el video, termina el ejercicio», que es el profesor
            // hablándole al alumno y es parte de la clase. Midiendo el curso
            // entero, siete casos crudos y cuatro de verdad.
            if (!/[.,;:!?…"»]$/.test(texto)) continue;
            ordenes.push({
                clase: cls.numero,
                bloque: block.index + 1,
                palabra: texto,
                aireIn: aire(block.in),
                aireOut: aire(block.out),
                duracion: block.endSec - block.startSec,
                texto: dentro.slice(Math.max(0, i - 3), i + 4).map(edges.textOf).join(' ')
            });
        }

        for (const kind of ['in', 'out']) {
            const edge = block[kind];
            if (!edge) continue;
            bordes++;
            const codigo = edge.audio && edge.audio.code;
            if (codigo === 'sin-medida') {
                sinMedida.push({ clase: cls.numero, bloque: block.index + 1, kind: kind.toUpperCase() });
                continue;
            }
            const a = aire(edge);
            if (a == null) continue;
            // El desacuerdo es cuánto se aparta el aire real del colchón que se
            // pidió. Negativo grande = la onda dice que ahí hay sonido y el
            // corte entró igual; positivo grande = la onda dice que el sonido
            // está lejos y el corte se quedó donde dijo el transcript.
            const separacion = a - COLCHON;
            if (Math.abs(separacion) < DESACUERDO) continue;
            desacuerdos.push({
                clase: cls.numero,
                bloque: block.index + 1,
                kind: kind.toUpperCase(),
                aire: a,
                separacion,
                lado: a < 0 ? 'la onda dice que hay sonido' : 'la onda dice que el sonido está lejos',
                codigo: codigo || '—'
            });
        }
    }
}

console.log(`\n${bloques} bloques · ${bordes} bordes medidos\n`);

console.log('1. órdenes al editor sobrevivientes DENTRO de un bloque');
if (!ordenes.length) {
    console.log('   ninguna: el patrón del "Pausa." del bloque 8 de la clase 6 no se repite.\n');
} else {
    const clasesCon = new Set(ordenes.map(o => o.clase));
    console.log(`   ${ordenes.length} en ${clasesCon.size} clases`);
    for (const o of ordenes) {
        const air = n => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}`);
        console.log(`   clase ${o.clase} b${o.bloque}: «${o.palabra}» · ${o.duracion.toFixed(2)}s · ` +
            `aire ${air(o.aireIn)} / ${air(o.aireOut)} frames`);
        if (detalle) console.log(`        …${o.texto}…`);
    }
    console.log('');
}

console.log('2. bordes donde la onda y el transcript no dicen lo mismo');
const dentroDelSonido = desacuerdos.filter(d => d.aire < 0);
const lejosDelSonido = desacuerdos.filter(d => d.aire >= 0);
const pct = n => `${Math.round((n / Math.max(1, bordes)) * 100)}%`;
console.log(`   ${desacuerdos.length} de ${bordes} (${pct(desacuerdos.length)}) se apartan más de ` +
    `${DESACUERDO} frames del colchón de ${COLCHON}`);
console.log(`     la onda dice que ahí hay sonido      : ${dentroDelSonido.length}`);
console.log(`     la onda dice que el sonido está lejos: ${lejosDelSonido.length}`);
console.log(`   ${sinMedida.length} bordes donde la onda no pudo afirmar nada (código sin-medida)`);

if (desacuerdos.length) {
    const tamanos = desacuerdos.map(d => Math.abs(d.separacion)).sort((a, b) => a - b);
    const mediana = tamanos[Math.floor(tamanos.length / 2)];
    console.log(`   tamaño del desacuerdo: mediana ${mediana.toFixed(0)} frames ` +
        `(${(mediana / 30).toFixed(2)}s) · peor ${tamanos[tamanos.length - 1].toFixed(0)} frames ` +
        `(${(tamanos[tamanos.length - 1] / 30).toFixed(2)}s)`);
}

if (detalle) {
    console.log('\n   los veinte peores:');
    for (const d of [...desacuerdos].sort((a, b) => Math.abs(b.separacion) - Math.abs(a.separacion)).slice(0, 20)) {
        console.log(`     clase ${d.clase} b${d.bloque} ${d.kind}: ${d.aire.toFixed(1)} frames de aire ` +
            `(${(d.aire / 30).toFixed(2)}s) · ${d.lado} · ${d.codigo}`);
    }
}
console.log('');
