'use strict';
/**
 * comparar-bordes.js — Dos corridas de `medir-repaso.js`, puestas una al lado de
 * la otra.
 *
 * La tabla de defectos que imprime `medir-repaso` dice CUÁNTOS hay, y con eso
 * solo no alcanza para decidir si una variante sirve. Ya pasó una vez en este
 * proyecto: la primera versión del re-timeo arreglaba los extremos y rompía lo
 * sano, y el total no lo mostraba porque lo que ganaba de un lado lo perdía del
 * otro. Un brazo que arregla tres bordes y rompe tres empata en el total y no
 * es lo mismo que uno que no tocó nada: el primero es una lotería y el segundo,
 * nada. Así que acá se cuenta cuántos bordes se movieron, en qué dirección y
 * cuántos bloques ganaron o perdieron defectos.
 *
 * **Una vara por reloj.** Los defectos se cuentan mirando qué palabras caen dentro
 * de cada bloque, así que cambiarle los tiempos a las palabras cambia también la
 * vara. Una variante podría "mejorar" nada más porque se la mide distinto. Por eso
 * `medir-repaso` vuelca la lectura de cada plan con TODOS los relojes y acá se
 * muestra una columna por reloj: sin la columna del reloj común, la comparación se
 * estaría haciendo trampa sola.
 *
 * **Los hallazgos de la lectura van aparte** y no sumados a los defectos de
 * borde. Son cosas distintas —uno lo mide una regla sobre el texto, el otro lo
 * dice el modelo leyendo la clase— y mezclarlos esconde cuál de los dos se
 * movió.
 *
 *   node tools/comparar-bordes.js /tmp/ab-A.json /tmp/ab-B.json
 */

const fs = require('fs');

const defectos = require('./defectos');

/**
 * Cuánto se tiene que mover un borde para que cuente.
 *
 * Un frame a 30 fps. Por debajo de eso el corte no puede caer en otro lado —el
 * XML se escribe en frames— así que una diferencia menor es aritmética del
 * plan, no una decisión distinta.
 */
const MUEVE_SEC = 1 / 30;

const archivoA = process.argv[2];
const archivoB = process.argv[3];

if (!archivoA || !archivoB) {
    console.error('Uso: node tools/comparar-bordes.js /tmp/ab-A.json /tmp/ab-B.json');
    process.exit(1);
}

const A = JSON.parse(fs.readFileSync(archivoA, 'utf8'));
const B = JSON.parse(fs.readFileSync(archivoB, 'utf8'));

// Las corridas viejas traían `retimeo: true|false` en vez del nombre del reloj.
const nombre = corrida => corrida.reloj || (corrida.retimeo ? 'onda' : 'crudo');

/** Suma por tipo de defecto de todas las clases de una corrida, con un reloj. */
function sumar(corrida, reloj) {
    const total = Object.fromEntries(defectos.TIPOS.map(t => [t, 0]));
    for (const cls of corrida.clases) {
        const tabla = (cls.defectosPorReloj || {})[reloj]
            // Una corrida vieja solo tiene dos lecturas y no dice de qué reloj es
            // cada una más que por el brazo.
            || (reloj === nombre(corrida) ? cls.defectos : cls.defectosOtroReloj);
        for (const tipo of defectos.TIPOS) total[tipo] += (tabla || {})[tipo] || 0;
    }
    return total;
}

/** Los relojes con los que las dos corridas midieron, para poner una columna a cada uno. */
function relojesComunes() {
    const hay = corrida => new Set(corrida.clases.flatMap(c => Object.keys(c.defectosPorReloj || {})));
    const enA = hay(A);
    const enB = hay(B);
    const comunes = [...enA].filter(r => enB.has(r));
    // Con corridas viejas no hay de dónde sacarlo: son las dos de siempre.
    return comunes.length ? comunes : ['crudo', 'onda'];
}

function totalDe(tabla) {
    return defectos.TIPOS.reduce((n, t) => n + tabla[t], 0);
}

function flecha(a, b) {
    if (b < a) return '↓';
    return b > a ? '↑' : '=';
}

// ─── Los defectos, en las cuatro celdas ────────────────────────────────────

// Agrupando por reloj y no por corrida, cada columna compara dos planes con la
// misma vara.
const relojes = relojesComunes();
const celdas = Object.fromEntries(relojes.map(r => [r, { A: sumar(A, r), B: sumar(B, r) }]));

const bloquesA = A.clases.reduce((n, c) => n + c.bloques.filter(b => b.enabled).length, 0);
const bloquesB = B.clases.reduce((n, c) => n + c.bloques.filter(b => b.enabled).length, 0);

console.log(`\nA: decidido con ${nombre(A)} · ${A.clases.length} clases · ${bloquesA} bloques vivos`);
console.log(`B: decidido con ${nombre(B)} · ${B.clases.length} clases · ${bloquesB} bloques vivos`);
console.log(`modelo: ${A.modelo}${A.modelo === B.modelo ? '' : ` / ${B.modelo}`}\n`);

const fila = (etiqueta, dato) => `  ${etiqueta.padEnd(14)}` +
    relojes.map(r => `${String(dato(r, 'A')).padStart(8)}${String(dato(r, 'B')).padStart(8)}` +
        `  ${dato(r, 'flecha')}`.padEnd(6)).join('');

console.log(`  ${''.padEnd(14)}${relojes.map(r => `medido con «${r}»`.padStart(22)).join('')}`);
console.log(fila('defecto', (r, cual) => (cual === 'flecha' ? ' ' : cual)));
for (const tipo of defectos.TIPOS) {
    if (!relojes.some(r => celdas[r].A[tipo] || celdas[r].B[tipo])) continue;
    console.log(fila(tipo, (r, cual) => (cual === 'flecha'
        ? flecha(celdas[r].A[tipo], celdas[r].B[tipo])
        : celdas[r][cual][tipo])));
}
console.log(fila('TOTAL', (r, cual) => (cual === 'flecha'
    ? flecha(totalDe(celdas[r].A), totalDe(celdas[r].B))
    : totalDe(celdas[r][cual]))));

// ─── Los bordes que se movieron ────────────────────────────────────────────

const porClaseB = new Map(B.clases.map(c => [c.clase, c]));
const movidos = { IN: { adelante: [], atras: [] }, OUT: { adelante: [], atras: [] } };
let bordesComparados = 0;
let apagadosDistinto = 0;
let bloquesSoloEnUno = 0;

for (const clsA of A.clases) {
    const clsB = porClaseB.get(clsA.clase);
    if (!clsB) continue;
    const porIndice = new Map(clsB.bloques.map(b => [b.index, b]));
    for (const a of clsA.bloques) {
        const b = porIndice.get(a.index);
        if (!b) { bloquesSoloEnUno++; continue; }
        if (a.enabled !== b.enabled) apagadosDistinto++;
        // Un bloque que en un brazo no sale no tiene bordes que comparar: lo que
        // cambió ahí es otra cosa y se cuenta arriba.
        if (!a.enabled || !b.enabled) continue;
        bordesComparados += 2;
        for (const [tipo, x, y] of [['IN', a.startSec, b.startSec], ['OUT', a.endSec, b.endSec]]) {
            const delta = y - x;
            if (Math.abs(delta) < MUEVE_SEC) continue;
            movidos[tipo][delta > 0 ? 'adelante' : 'atras'].push({
                clase: clsA.clase, bloque: a.index + 1, delta
            });
        }
    }
}

function mediana(lista) {
    if (!lista.length) return 0;
    const orden = lista.map(x => Math.abs(x.delta)).sort((p, q) => p - q);
    return orden[Math.floor(orden.length / 2)];
}

const totalMovidos = ['IN', 'OUT'].reduce(
    (n, k) => n + movidos[k].adelante.length + movidos[k].atras.length, 0);

console.log(`\n${totalMovidos} de ${bordesComparados} bordes se movieron más de un frame\n`);
for (const tipo of ['IN', 'OUT']) {
    for (const [rumbo, texto] of [['adelante', 'más tarde'], ['atras', 'más temprano']]) {
        const lista = movidos[tipo][rumbo];
        if (!lista.length) { console.log(`  ${tipo.padEnd(4)}${texto.padEnd(14)}   0`); continue; }
        const suma = lista.reduce((n, x) => n + Math.abs(x.delta), 0);
        console.log(`  ${tipo.padEnd(4)}${texto.padEnd(14)} ${String(lista.length).padStart(3)} · ` +
            `mediana ${mediana(lista).toFixed(2)}s · mayor ${Math.max(...lista.map(x => Math.abs(x.delta))).toFixed(2)}s · ` +
            `${suma.toFixed(1)}s en total`);
    }
}
if (apagadosDistinto) console.log(`  ${apagadosDistinto} bloques encendidos en un brazo y apagados en el otro`);
if (bloquesSoloEnUno) console.log(`  ${bloquesSoloEnUno} bloques que existen en un solo brazo`);

// ─── Qué bloque ganó y cuál perdió ─────────────────────────────────────────
//
// El total puede empatar tapando que se arreglaron tres bordes y se rompieron
// otros tres. Esto se cuenta con el reloj de cada brazo, que es la lectura
// coherente de su propio plan.

function porBloque(cls) {
    const mapa = new Map();
    for (const e of cls.ejemplos || []) {
        mapa.set(e.bloque, (mapa.get(e.bloque) || 0) + 1);
    }
    return mapa;
}

let mejoraron = 0;
let empeoraron = 0;
const detalleMejor = [];
const detallePeor = [];

for (const clsA of A.clases) {
    const clsB = porClaseB.get(clsA.clase);
    if (!clsB) continue;
    const a = porBloque(clsA);
    const b = porBloque(clsB);
    for (const bloque of new Set([...a.keys(), ...b.keys()])) {
        const antes = a.get(bloque) || 0;
        const despues = b.get(bloque) || 0;
        if (despues < antes) { mejoraron++; detalleMejor.push(`clase ${clsA.clase} b${bloque} (${antes}→${despues})`); }
        if (despues > antes) { empeoraron++; detallePeor.push(`clase ${clsA.clase} b${bloque} (${antes}→${despues})`); }
    }
}

console.log(`\n  ${mejoraron} bloques con menos defectos · ${empeoraron} con más`);
if (detalleMejor.length) console.log(`    mejor: ${detalleMejor.join(' · ')}`);
if (detallePeor.length) console.log(`    peor : ${detallePeor.join(' · ')}`);

// ─── Los hallazgos de la lectura, aparte ───────────────────────────────────
//
// Cambiarle los tiempos a las palabras cambia el texto que ve el modelo, así que
// la lectura puede encontrar otras cosas. Es un efecto distinto del de los
// bordes y se informa por separado: sumarlos escondería cuál de los dos se
// movió.

function lectura(corrida) {
    const cuenta = { pendientes: 0, corregidos: 0, porTipo: new Map() };
    for (const cls of corrida.clases) {
        for (const f of cls.hallazgos || []) {
            if (f.corregido) cuenta.corregidos++;
            else cuenta.pendientes++;
            const clave = f.tipo || 'otro';
            const previo = cuenta.porTipo.get(clave) || { pendientes: 0, corregidos: 0 };
            previo[f.corregido ? 'corregidos' : 'pendientes']++;
            cuenta.porTipo.set(clave, previo);
        }
    }
    return cuenta;
}

const lecA = lectura(A);
const lecB = lectura(B);
const tipos = new Set([...lecA.porTipo.keys(), ...lecB.porTipo.keys()]);

console.log('\nlo que encontró la lectura del guion (aparte de los bordes)\n');
console.log(`  ${'hallazgo'.padEnd(16)}${'A pend'.padStart(9)}${'B pend'.padStart(9)}${'A arr'.padStart(9)}${'B arr'.padStart(9)}`);
for (const tipo of [...tipos].sort()) {
    const a = lecA.porTipo.get(tipo) || { pendientes: 0, corregidos: 0 };
    const b = lecB.porTipo.get(tipo) || { pendientes: 0, corregidos: 0 };
    console.log(`  ${tipo.padEnd(16)}${String(a.pendientes).padStart(9)}${String(b.pendientes).padStart(9)}` +
        `${String(a.corregidos).padStart(9)}${String(b.corregidos).padStart(9)}`);
}
console.log(`  ${'TOTAL'.padEnd(16)}${String(lecA.pendientes).padStart(9)}${String(lecB.pendientes).padStart(9)}` +
    `${String(lecA.corregidos).padStart(9)}${String(lecB.corregidos).padStart(9)}`);
console.log('');
