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
    'transcribe.test.js',
    'align.test.js',
    'export.test.js',
    'criterio.test.js',
    'modelo-local.test.js'
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

const t = {
    group(name) { currentGroup = name; console.log(`\n${name}`); },

    test(name, fn) {
        try {
            fn();
            state.pass++;
            console.log(`  ✓ ${name}`);
        } catch (err) {
            state.fail++;
            state.failures.push({ group: currentGroup, name, message: err.message });
            console.log(`  ✗ ${name}\n      ${err.message}`);
        }
    },

    skip(name, why) {
        state.skip++;
        console.log(`  – ${name} (${why})`);
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

for (const file of FILES) {
    if (filter && !file.includes(filter)) continue;
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) continue;
    require(full)(t);
}

console.log(`\n${state.pass} pasaron · ${state.fail} fallaron · ${state.skip} salteados`);
if (state.fail) {
    console.log('\nFallos:');
    for (const f of state.failures) console.log(`  ${f.group} → ${f.name}\n    ${f.message}`);
    process.exit(1);
}
