'use strict';
/**
 * ver-marcadores.js — Arma el XML del corte de una clase real y lo escribe en
 * /tmp para poder abrirlo y leerlo.
 *
 * Solo LEE del material del usuario: el XML que sale va a /tmp, nunca a
 * `The Cutter`. Sirve para comprobar contra datos de verdad lo que las pruebas
 * comprueban con datos inventados — que un bloque sin nota no trae marcador, que
 * el de un bloque con nota empieza y termina con el bloque, y que un comentario
 * de selección sale blanco y con el largo de la selección.
 *
 *   node tools/ver-marcadores.js <raíz> [nombre-de-secuencia]
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const rodecaster = require('../engine/rodecaster-xml');
const workspace = require('../engine/workspace');
const exporter = require('../engine/export');
const fcp = require('../engine/fcp-xml');
const notas = require('../engine/notas');

function leer(root, sequenceName, cual) {
    const datos = workspace.readJson(workspace.artifact(root, sequenceName, cual));
    if (!datos) throw new Error(`Falta el artefacto ${cual} de ${sequenceName}.`);
    return datos;
}

function main() {
    const root = process.argv[2];
    if (!root) throw new Error('Falta la raíz del curso.');

    const backup = path.join(root, 'The Cutter', 'Backup');
    const nombres = [...new Set(fs.readdirSync(backup)
        .filter(f => f.endsWith('_cutplan.json'))
        .map(f => f.replace(/_cutplan\.json$/, '')))].sort();

    const sequenceName = process.argv[3] || nombres[0];
    if (!sequenceName) throw new Error('No hay ninguna clase con cutplan.');

    const plan = leer(root, sequenceName, 'cutplan');
    const align = leer(root, sequenceName, 'align');
    const guardadas = notas.leer(root, sequenceName);

    // El XML de origen, para poder decir de cada bloque si el CD le escribió algo.
    const xmlPath = fs.readdirSync(root)
        .map(f => path.join(root, f))
        .find(f => f.endsWith('.xml') && f.includes(sequenceName.split('_')[0]))
        || path.join(root, `${sequenceName}.xml`);
    const parsed = rodecaster.parseFile(xmlPath);

    // Un comentario de selección de mentira, para ver el marcador blanco. Va en
    // memoria y no se guarda: el archivo de notas del usuario no se toca.
    const primero = plan.segments.find(s => s.keep);
    const inventado = {
        id: 'prueba',
        sourceStartSec: primero.sourceStartSec + 5,
        sourceEndSec: primero.sourceStartSec + 9.5,
        texto: 'lo que estaba seleccionado',
        comentario: 'COMENTARIO DE PRUEBA sobre una selección de 4,5 s'
    };
    const conInventado = {
        ...guardadas,
        comentarios: [...guardadas.comentarios, inventado]
    };

    // El plan guarda las cámaras y los audios que usó, con su ruta: alcanza para
    // rearmar la clase sin volver a escanear el disco.
    const cls = {
        sequenceName,
        videos: plan.cameras || [],
        audios: plan.audios || []
    };

    const cut = exporter.cutTracks(cls, plan, conInventado);
    const xml = fcp.sequenceXml({
        fps: plan.fps || 30, width: 1920, height: 1080,
        name: sequenceName,
        videoTracks: cut.videoTracks, audioTracks: cut.audioTracks,
        markers: cut.markers, durationSec: cut.durationSec
    });

    const salida = path.join(os.tmpdir(), `marcadores_${sequenceName}.xml`);
    fs.writeFileSync(salida, xml, 'utf8');

    console.log(`clase        ${sequenceName}`);
    console.log(`bloques      ${plan.segments.filter(s => s.keep).length} en el corte`);
    if (parsed.ok) {
        const conNota = parsed.blocks.filter(b => (b.note || '').trim()).length;
        console.log(`notas del CD ${conNota} de ${parsed.blocks.length} bloques`);
    }
    console.log(`comentarios  ${guardadas.comentarios.length} guardados + 1 inventado para la prueba`);

    const deBloque = cut.markers.filter(m => m.name !== 'Nota');
    const largos = deBloque.filter(m => m.endSec != null).length;
    console.log(`marcadores   ${cut.markers.length} = ${deBloque.length} de bloque ` +
        `(${largos} largos con nota, ${deBloque.length - largos} cortos para saltar) ` +
        `+ ${cut.markers.length - deBloque.length} de selección`);
    console.log(`XML          ${salida}`);
    console.log(`\nel comentario inventado va de ${inventado.sourceStartSec.toFixed(2)} a ` +
        `${inventado.sourceEndSec.toFixed(2)} del original\n`);

    for (const s of plan.segments.filter(x => x.keep)) {
        const nota = (s.note || '').trim();
        console.log(`  bloque ${String(s.blockIndex + 1).padStart(2)} ${s.view.padEnd(2)} ` +
            `${s.timelineStartSec.toFixed(2)}→${s.timelineEndSec.toFixed(2)}  ` +
            (nota ? `nota: ${JSON.stringify(nota.slice(0, 48))}` : `SIN NOTA (cue: ${JSON.stringify((s.cueIn || '').slice(0, 34))})`));
    }
    // Los segmentos vienen ordenados por su sitio en la línea de tiempo, y los
    // marcadores también, así que se pueden leer en paralelo.
    console.log('');
    for (const m of cut.markers) {
        const largo = m.endSec != null
            ? `${m.startSec.toFixed(2)}→${m.endSec.toFixed(2)} (${(m.endSec - m.startSec).toFixed(2)}s)`
            : `${m.startSec.toFixed(2)} (corto)`;
        console.log(`  MARCADOR ${largo.padEnd(28)} [${m.name}] color=${m.color}` +
            (m.comment ? ` · ${String(m.comment).slice(0, 52)}` : ''));
    }
}

main();
