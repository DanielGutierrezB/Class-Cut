'use strict';
/**
 * Que la plantilla anotada se revise, y no solo se confirme que el archivo está.
 *
 * Una anotación buena se pudre de dos maneras. Una es visible: la mueven, la
 * renombran, o vive en un disco que hoy no está enchufado. La otra es callada, y
 * es la que importa: el archivo sigue ahí, pero ya no sirve de molde — porque la
 * anotación se guardó antes de que existiera la revisión, o porque el editor
 * abrió ese proyecto y le sacó de la línea de tiempo justo el clip estéreo del
 * que copiábamos.
 *
 * Si eso no se revisa acá, el botón arranca contento y el armado se cae a mitad
 * del curso, que es el peor momento para enterarse: ya no queda nada que hacer
 * salvo mostrar un error. Revisándolo acá todavía se puede buscar otra.
 *
 * Se prueba con `sirveTodavia` a través de `porQueNoSirve`, que es la misma
 * revisión que corre al elegir una a mano; que un `.prproj` de verdad pase o no
 * pase se prueba en `tools/prproj-molde.js`, con proyectos del disco.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ipc = require('../ipc/prproj');

module.exports = t => {

    t.group('la plantilla anotada · revisarla, no solo encontrarla');

    t.test('un archivo que no está no sirve', () => {
        t.ok(ipc.porQueNoSirve, 'la revisión se exporta para poder mirarla');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-anotada-'));
        const fantasma = path.join(dir, 'se-fue.prproj');
        // Sin archivo, la revisión tiene que contestar un motivo y no tirar: es
        // el caso del disco externo desenchufado, que pasa todo el tiempo.
        t.ok(ipc.porQueNoSirve(fantasma), 'contesta un motivo en vez de explotar');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('un archivo que no es gzip da un motivo que dice qué mirar', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-anotada-'));
        const ruta = path.join(dir, 'no-es.prproj');
        fs.writeFileSync(ruta, 'esto no es un proyecto');
        const motivo = ipc.porQueNoSirve(ruta);
        t.ok(/dañado|otro programa/.test(motivo),
            `el motivo tiene que orientar, y dice: ${motivo}`);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('un gzip que no es de Premiere se distingue de uno dañado', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-anotada-'));
        const ruta = path.join(dir, 'ajeno.prproj');
        fs.writeFileSync(ruta, zlib.gzipSync(Buffer.from('<OtraCosa/>', 'utf8')));
        const motivo = ipc.porQueNoSirve(ruta);
        t.ok(/no es un proyecto de Premiere/.test(motivo),
            `se abre pero no es lo que decimos, y el motivo lo dice: ${motivo}`);
        fs.rmSync(dir, { recursive: true, force: true });
    });
};
