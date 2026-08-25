'use strict';
/**
 * banco-contexto.js — ¿Conviene darle al modelo la clase entera?
 *
 * Al afinar un borde el modelo ve unas 60 palabras alrededor del corte. La
 * alternativa es ponerle además la clase completa de fondo, para que pueda ver
 * si lo que está por dejar afuera se rehace más adelante. Suena mejor, pero
 * "suena mejor" no es un argumento: los modelos chicos se desordenan cuando el
 * prompt crece, y acá el que va empaquetado es un 4B.
 *
 * Esto corre las dos formas sobre las mismas clases, con el mismo modelo y el
 * mismo alineado de partida, y las mide con la misma vara que
 * `tools/medir-cortes.js` — de ahí sale `tools/defectos.js`, para que el banco
 * no pueda declarar una mejora que la medición oficial no vea.
 *
 *   node tools/banco-contexto.js /ruta/al/curso [--clases 1,4,10] [--modelo qwen3:4b]
 */

const scanner = require('../engine/course-scan');
const probe = require('../engine/media-probe');
const transcribe = require('../engine/transcribe');
const onset = require('../engine/vendor/audio-onset');
const align = require('../engine/align');
const cutRefine = require('../engine/cut-refine');
const entera = require('../engine/clase-entera');
const ollamaServer = require('../engine/ollama-server');
const ai = require('../engine/ai-local');
const defectos = require('./defectos');
const cumplidas = require('./ordenes-cumplidas');

const root = process.argv[2];
const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
};

if (!root) {
    console.error('Falta la ruta. Uso: node tools/banco-contexto.js /ruta/al/curso [--clases 1,4] [--modelo m]');
    process.exit(1);
}

const wanted = (arg('clases') || '1,4,10').split(',').map(Number);
const modelo = arg('modelo') || 'qwen3:4b';

const clon = x => JSON.parse(JSON.stringify(x));
const timecode = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Lo que se oiría a cada lado de un corte, para poder juzgarlo leyendo. */
function alrededor(words, timeSec, kind) {
    const spoken = words.filter(w => (w.text || '').trim());
    const antes = spoken.filter(w => w.end <= timeSec + 0.02).slice(-9);
    const despues = spoken.filter(w => w.start >= timeSec - 0.02).slice(0, 9);
    const txt = list => list.map(w => w.text.trim()).join(' ').trim() || '—';
    return kind === 'IN'
        ? { corta: txt(antes), conserva: txt(despues) }
        : { conserva: txt(antes), corta: txt(despues) };
}

/** Los bordes de una clase, en frames: es la unidad en la que importa. */
function bordesDe(alignResult, fps) {
    const out = new Map();
    for (const block of alignResult.blocks || []) {
        out.set(`${block.index}:IN`, Math.round(block.startSec * fps));
        out.set(`${block.index}:OUT`, Math.round(block.endSec * fps));
    }
    return out;
}

(async () => {
    const scan = scanner.scan(root);
    if (!scan.ok) { console.error(scan.error); process.exit(1); }

    const classes = scan.classes.filter(c => c.processable && wanted.includes(c.classNumber));
    if (!classes.length) { console.error('Ninguna de esas clases se puede procesar.'); process.exit(1); }
    await probe.probeClasses(classes);

    // El alineado determinista no depende del contexto, así que se hace una vez
    // por clase: las dos variantes tienen que partir exactamente de lo mismo o
    // lo que se mide es el ruido del alineado.
    const listas = [];
    for (const cls of classes) {
        const fps = cls.fps || 30;
        const transcript = await transcribe.transcribeClass({
            root: scan.root, sequenceName: cls.sequenceName, wavPath: cls.liveMixPath, fps
        });
        const info = cls.liveMixPath ? onset.wavInfo(cls.liveMixPath) : null;
        const wav = info ? { file: cls.liveMixPath, info } : null;
        const base = align.alignClass({
            blocks: cls.blocks || [], words: transcript.words, wav,
            classNumber: cls.classNumber, clapMarkerSec: cls.clapSec,
            durationSec: cls.durationSec, options: { fps }
        });
        listas.push({ cls, fps, words: transcript.words, wav, base });
        process.stdout.write(`\rpreparando… clase ${cls.classNumber}   `);
    }

    const palabras = listas.reduce((n, p) => n + p.words.length, 0);
    const textoClase = listas.map(p => entera.texto(p.base.blocks, p.words));
    const charsClase = textoClase.reduce((n, t) => n + t.length, 0);
    console.log(`\r${listas.length} clases · ${palabras} palabras · ` +
        `la clase entera ocupa ${Math.round(charsClase / listas.length)} chars de media ` +
        `(~${Math.round(charsClase / listas.length / 3)} tokens)\n`);

    const arranque = await ollamaServer.ensure({ model: modelo });
    if (!arranque.cliente) { console.error(`No hay modelo local: ${arranque.reason}`); process.exit(1); }
    const cliente = ai.cliente({ url: arranque.cliente.url, model: arranque.model });
    console.log(`modelo: ${arranque.model} (${arranque.source})\n`);

    async function correr(nombre, opciones) {
        const desde = Date.now();
        const cuenta = Object.fromEntries(defectos.TIPOS.map(t => [t, 0]));
        const stats = { consultas: 0, fallosDelModelo: 0, cambiados: 0 };
        const ordenes = { total: 0, cumplidas: 0, lejos: 0, sinUbicar: 0 };
        const bordes = new Map();
        const detalle = new Map();
        let bloques = 0;

        for (const p of listas) {
            const alignResult = clon(p.base);
            await cutRefine.refineClass({
                alignResult, words: p.words, wav: p.wav,
                options: { fps: p.fps, ...opciones },
                ai: cliente
            });

            const s = alignResult.refine || {};
            stats.consultas += s.consultas || 0;
            stats.fallosDelModelo += s.fallosDelModelo || 0;
            stats.cambiados += s.cambiados || 0;

            const medido = defectos.contarClase(p.words, alignResult.blocks);
            for (const tipo of defectos.TIPOS) cuenta[tipo] += medido.cuenta[tipo];
            bloques += medido.total;

            const ord = cumplidas.medirClase(alignResult.blocks, p.words, { fps: p.fps });
            for (const k of Object.keys(ordenes)) ordenes[k] += ord[k];

            for (const [k, v] of bordesDe(alignResult, p.fps)) bordes.set(`${p.cls.classNumber}/${k}`, v);
            for (const block of alignResult.blocks || []) {
                for (const kind of ['IN', 'OUT']) {
                    const edge = kind === 'IN' ? block.in : block.out;
                    if (!edge) continue;
                    detalle.set(`${p.cls.classNumber}/${block.index}:${kind}`, {
                        at: kind === 'IN' ? block.startSec : block.endSec,
                        words: p.words, kind,
                        decidedBy: edge.refine ? edge.refine.decidedBy : '',
                        reason: edge.refine ? edge.refine.reason : ''
                    });
                }
            }
        }
        const total = defectos.TIPOS.reduce((n, t) => n + cuenta[t], 0);
        return { nombre, cuenta, total, bloques, stats, ordenes, bordes, detalle, secs: (Date.now() - desde) / 1000 };
    }

    // El orden importa para los tiempos: si otra cosa carga la máquina mientras
    // corre el banco, la última variante parece más lenta sin serlo. Se corren
    // dos veces en orden invertido y de cada una se toma el mejor tiempo.
    const variantes = [
        ['sin órdenes', { contexto: 'ventana', mirar: 'dudosos', preguntar: 'todos', ordenes: 'ignorar' }],
        ['hoy', { contexto: 'ventana', mirar: 'dudosos', preguntar: 'todos' }],
        ['clase entera', { contexto: 'clase', mirar: 'dudosos', preguntar: 'todos' }],
        ['regla a todos', { contexto: 'ventana', mirar: 'todos', preguntar: 'dudosos' }],
        ['todo a todos', { contexto: 'ventana', mirar: 'todos', preguntar: 'todos' }]
    ];

    const solo = arg('solo');
    const elegidas = solo
        ? variantes.filter(v => solo.split(',').includes(v[0]))
        : variantes;

    // Los tiempos de una sola corrida no sirven: entre una variante y la
    // siguiente cambia la carga de la máquina y el estado del caché de Ollama, y
    // se llega a resultados que se contradicen entre corridas. Con varias rondas
    // alternando el orden, de cada variante se toma el mejor tiempo, que es el
    // que menos ruido de otras cosas tiene metido.
    const rondas = Number(arg('rondas')) || 1;
    const porNombre = new Map();
    for (let ronda = 0; ronda < rondas; ronda++) {
        const orden = ronda % 2 ? [...elegidas].reverse() : elegidas;
        for (const [nombre, opciones] of orden) {
            process.stdout.write(`ronda ${ronda + 1} · «${nombre}»…\n`);
            const r = await correr(nombre, opciones);
            const previo = porNombre.get(nombre);
            if (!previo) porNombre.set(nombre, { ...r, tiempos: [r.secs] });
            else {
                previo.tiempos.push(r.secs);
                previo.secs = Math.min(previo.secs, r.secs);
            }
        }
    }
    const resultados = elegidas.map(v => porNombre.get(v[0])).filter(Boolean);

    const base = resultados[0];
    console.log(`\n${base.bloques} bloques medidos por variante\n`);
    const cols = resultados.map(r => r.nombre.padStart(13)).join('');
    console.log(`  ${'defecto'.padEnd(16)}${cols}`);
    for (const tipo of defectos.TIPOS) {
        const fila = resultados.map(r => String(r.cuenta[tipo]).padStart(13)).join('');
        console.log(`  ${tipo.padEnd(16)}${fila}`);
    }
    console.log(`  ${'TOTAL'.padEnd(16)}${resultados.map(r => String(r.total).padStart(13)).join('')}`);

    // Los defectos son heurísticos; esto no. El CD escribió dónde iba el corte y
    // o se hizo o no se hizo.
    if (base.ordenes.total) {
        const fila = resultados.map(r =>
            `${r.ordenes.cumplidas}/${r.ordenes.total}`.padStart(13)).join('');
        console.log(`\n  ${'órdenes del CD'.padEnd(16)}${fila}`);
    }

    for (const r of resultados) {
        const contra = r === base ? '' :
            ` · ${r.total < base.total ? `${base.total - r.total} defectos menos` :
                (r.total > base.total ? `${r.total - base.total} defectos MÁS` : 'igual')}`;
        const spread = r.tiempos && r.tiempos.length > 1
            ? ` (mejor de ${r.tiempos.map(s => Math.round(s)).join(', ')})`
            : '';
        console.log(`\n  «${r.nombre}»: ${r.stats.consultas} consultas · ` +
            `${r.stats.fallosDelModelo} inválidas · ${r.stats.cambiados} bordes movidos · ` +
            `${Math.round(r.secs)}s${spread}${contra}`);
    }

    for (const r of resultados.slice(1)) {
        let distintos = 0;
        const lineas = [];
        for (const [key, frame] of base.bordes) {
            if (!r.bordes.has(key) || r.bordes.get(key) === frame) continue;
            distintos++;
            const da = base.detalle.get(key);
            const db = r.detalle.get(key);
            if (!da || !db || lineas.length >= 24) continue;
            const ca = alrededor(da.words, da.at, da.kind);
            const cb = alrededor(db.words, db.at, db.kind);
            lineas.push(`  ── ${key}\n` +
                `     hoy          @ ${timecode(da.at)} (${da.decidedBy || 'ni se miró'})\n` +
                `        conserva …${ca.conserva.slice(-68)}\n` +
                `        corta     ${ca.corta.slice(0, 68)}…\n` +
                `     ${r.nombre.padEnd(12)} @ ${timecode(db.at)} (${db.decidedBy || 'ni se miró'})\n` +
                `        conserva …${cb.conserva.slice(-68)}\n` +
                `        corta     ${cb.corta.slice(0, 68)}…`);
        }
        console.log(`\n\n═══ «${r.nombre}» mueve ${distintos} bordes respecto de hoy\n`);
        console.log(lineas.join('\n\n'));
    }

    ollamaServer.stop();
    process.exit(0);
})();
