'use strict';
/**
 * tests/run.js — Corredor de tests sin dependencias, sin red y sin abrir ningún
 * editor. Cada archivo `*.test.js` exporta una función que recibe el harness.
 *
 *   node tests/run.js
 *   node tests/run.js rodecaster   (solo los que matcheen)
 */

const path = require('path');
const fs = require('fs');

const FILES = [
    'rodecaster-xml.test.js',
    'course-scan.test.js',
    'carpetas.test.js',
    'estado-clase.test.js',
    'transcribe.test.js',
    'align.test.js',
    'aire.test.js',
    'ataque.test.js',
    'claqueta.test.js',
    'export.test.js',
    'criterio.test.js',
    'modelo-local.test.js',
    'ia.test.js',
    'tokens.test.js',
    'registro.test.js',
    'corrida.test.js',
    'actualizar.test.js',
    'pista.test.js',
    'letra.test.js',
    'onda.test.js',
    'picos.test.js',
    'volumen.test.js',
    'escucha.test.js',
    'estilos.test.js',
    'modulos.test.js',
    'notas.test.js',
    'regenerar.test.js',
    'silencios.test.js',
    'retimeo.test.js',
    'reloj.test.js',
    'guion.test.js',
    'historia.test.js',
    'repeticiones.test.js',
    'retoma.test.js',
    'repasar.test.js',
    'verificar-corte.test.js',
    'media-server.test.js'
];

const filter = process.argv[2] || '';
const state = { pass: 0, fail: 0, skip: 0, failures: [] };
let currentGroup = '';

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (typeof a !== 'object') return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
}

function show(value) {
    if (typeof value === 'string') return JSON.stringify(value);
    try { return JSON.stringify(value); } catch (e) { return String(value); }
}

// Los tests se registran al recorrer los archivos y se corren después, en orden.
// Es lo que permite esperar a los `async` sin tener que escribir `await t.test`
// en cada archivo: si no se espera, la promesa se resuelve pasado el resumen y
// el test cuenta como pasado aunque su aserción falle, que es peor que no tenerlo.
const queue = [];

const t = {
    group(name) {
        currentGroup = name;
        queue.push({ kind: 'group', name });
    },

    test(name, fn) {
        queue.push({ kind: 'test', group: currentGroup, name, fn });
    },

    skip(name, why) {
        queue.push({ kind: 'skip', name, why });
    },

    ok(value, message) {
        if (!value) throw new Error(message || `esperaba algo verdadero, llegó ${show(value)}`);
    },

    eq(actual, expected, message) {
        if (actual !== expected) {
            throw new Error(`${message || 'no coincide'}: esperaba ${show(expected)}, llegó ${show(actual)}`);
        }
    },

    deep(actual, expected, message) {
        if (!deepEqual(actual, expected)) {
            throw new Error(`${message || 'no coincide'}: esperaba ${show(expected)}, llegó ${show(actual)}`);
        }
    },

    near(actual, expected, tolerance, message) {
        if (Math.abs(actual - expected) > tolerance) {
            throw new Error(`${message || 'fuera de tolerancia'}: esperaba ${expected}±${tolerance}, llegó ${actual}`);
        }
    }
};

async function main() {
    for (const file of FILES) {
        if (filter && !file.includes(filter)) continue;
        const full = path.join(__dirname, file);
        if (!fs.existsSync(full)) continue;
        // Con `await`: los archivos que importan módulos de la ventana son
        // `async`, y sin esperarlos sus pruebas se anotaban DESPUÉS de arrancar
        // la corrida. Colaban igual porque la lista se recorre mientras se le
        // agregan cosas, pero corriendo uno solo con filtro no llegaban a
        // anotarse y la respuesta era "0 pasaron · 0 fallaron", que se lee como
        // que todo está bien.
        await require(full)(t);
    }

    for (const item of queue) {
        if (item.kind === 'group') {
            console.log(`\n${item.name}`);
            continue;
        }
        if (item.kind === 'skip') {
            state.skip++;
            console.log(`  – ${item.name} (${item.why})`);
            continue;
        }
        try {
            await item.fn();
            state.pass++;
            console.log(`  ✓ ${item.name}`);
        } catch (err) {
            state.fail++;
            state.failures.push({ group: item.group, name: item.name, message: err.message });
            console.log(`  ✗ ${item.name}\n      ${err.message}`);
        }
    }

    console.log(`\n${state.pass} pasaron · ${state.fail} fallaron · ${state.skip} salteados`);
    if (state.fail) {
        console.log('\nFallos:');
        for (const f of state.failures) console.log(`  ${f.group} → ${f.name}\n    ${f.message}`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(`\nEl corredor se cayó: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});
