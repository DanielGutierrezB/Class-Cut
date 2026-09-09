'use strict';
/**
 * medir-huecos.js — Qué recupera `oir.rellenarHuecos` sobre las clases reales.
 *
 * Un hueco es un tramo donde el mapa de voz oye a alguien sostenido y el
 * transcript no escribió ni una palabra. Esta herramienta los busca sobre los
 * transcripts ya guardados del curso, relee cada uno y muestra qué trajo, que es
 * la única forma de ver si la reja está en el sitio: si aparecen a montones, o si
 * lo que trae son créditos de subtítulos inventados, el listón está mal.
 *
 * Uso: node tools/medir-huecos.js <raíz del curso>
 */

const fs = require('fs');
const path = require('path');

const oir = require('../engine/oir');
const voz = require('../engine/voz');

function transcripts(dir, hallados) {
    for (const nombre of fs.readdirSync(dir)) {
        const p = path.join(dir, nombre);
        if (fs.statSync(p).isDirectory()) transcripts(p, hallados);
        else if (nombre.endsWith('_transcript.json')) hallados.push(p);
    }
    return hallados;
}

const mmss = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

async function main() {
    const raiz = process.argv[2];
    if (!raiz) { console.error('Falta la raíz del curso.'); process.exit(1); }

    // Una clase puede estar guardada en dos sitios; se mide una sola vez.
    const vistos = new Set();
    let huecos = 0;
    let palabras = 0;

    for (const archivo of transcripts(raiz, []).sort()) {
        const t = JSON.parse(fs.readFileSync(archivo, 'utf8'));
        const wav = t.source && t.source.path;
        if (!wav || !fs.existsSync(wav) || vistos.has(wav)) continue;
        vistos.add(wav);

        const mapa = voz.deLaClase(wav);
        if (!mapa) { console.log(`${path.basename(archivo).slice(0, 2)} · sin mapa de voz`); continue; }

        const encontrados = oir.huecos(t.words, mapa);
        console.log(`── clase ${path.basename(archivo).slice(0, 2)} · ${(mapa.duracionSec / 60).toFixed(0)} min` +
            ` · ${encontrados.length} huecos`);

        const relleno = await oir.rellenarHuecos(wav, t.words);
        const nuevas = relleno.words.filter(w => !t.words.includes(w));
        huecos += encontrados.length;
        palabras += nuevas.length;

        for (const hueco of encontrados) {
            const antes = t.words.filter(w => w.end <= hueco.desde).slice(-4).map(w => w.text).join(' ');
            const suyas = nuevas.filter(w => w.start >= hueco.desde && w.start < hueco.hasta);
            console.log(`   ${mmss(hueco.desde)} → ${mmss(hueco.hasta)}` +
                ` · tras «…${antes}»\n      ${JSON.stringify(suyas.map(w => w.text).join(' '))}`);
        }
    }
    console.log(`\n${huecos} huecos · ${palabras} palabras recuperadas.`);
}

main();
