'use strict';
/**
 * probar-recuadro.js — Deja armado el camino para que el editor conteste en una
 * importación qué acepta Premiere del recuadro.
 *
 * Nada de esto se puede comprobar sin Premiere: el formato define filtros, pero
 * cuáles lee su importador y en qué unidades no está escrito en ningún lado que se
 * pueda creer. Lo que sí se puede hacer es dejar la pregunta hecha de forma que
 * una sola importación la conteste, en vez de que él pruebe de a una.
 *
 * Escribe DOS archivos, siempre fuera de la carpeta del cliente:
 *
 *   <secuencia>-recuadro.xml    la clase entera con el recuadro puesto. Es el
 *                               archivo de verdad: si esto se ve bien, se ve bien.
 *   <secuencia>-variantes.xml   tres tramos cortos, uno detrás del otro, cada uno
 *                               con una forma distinta del filtro. Sirve para
 *                               separar QUÉ falló si el primero no sale bien.
 *
 *   node tools/probar-recuadro.js [--clase 04] [--curso <ruta>] [--salida /tmp]
 */

const fs = require('fs');
const path = require('path');

const courseScan = require('../engine/course-scan');
const mediaProbe = require('../engine/media-probe');
const fcp = require('../engine/fcp-xml');
const exporter = require('../engine/export');
const workspace = require('../engine/workspace');

const CURSO_POR_DEFECTO = '/Users/danielgutierrez/Movies/CUR/2026_curso-spec-driven-development';

/** Cuánto dura cada tramo de la secuencia de variantes. */
const TRAMO_SEC = 6;

function opciones(argv) {
    const o = { clase: '04', curso: CURSO_POR_DEFECTO, salida: '/tmp' };
    for (let i = 0; i < argv.length; i += 2) {
        const clave = String(argv[i]).replace(/^--/, '');
        if (clave in o) o[clave] = argv[i + 1];
    }
    return o;
}

/**
 * Las tres formas del filtro que se ponen a competir.
 *
 * Las dos primeras se diferencian solo en DÓNDE va el recorte, que es la duda que
 * queda: Premiere escribe `leftcrop` adentro de Basic Motion, pero su importador
 * también conoce los nombres canónicos del formato en un filtro `crop` aparte, y
 * no hay manera de saber cuál gana sin importar.
 *
 * La tercera existe para descartar la otra duda, la de las unidades del `center`.
 * Las cuentas dicen que va dividido por el cuadro entero (ver
 * `aUnidadesDelCuadro`), así que esta lo divide por la mitad —el doble de
 * desplazamiento— y tiene que salir MAL. Si saliera bien, la que hay que corregir
 * es la de fábrica.
 */
function variantes(medidas) {
    const base = fcp.encuadreDelRecuadro(medidas);
    const aparte = fcp.encuadreDelRecuadro({ ...medidas, dialectoDelRecorte: fcp.RECORTE_APARTE });
    return [
        {
            letra: 'A',
            que: 'recorte adentro de Basic Motion (la de fábrica)',
            espero: 'cuadrado, abajo a la derecha',
            encuadre: base
        },
        {
            letra: 'B',
            que: 'recorte en un filtro Crop aparte',
            espero: 'igual que A si Premiere lee el filtro Crop; 16:9 si lo ignora',
            encuadre: aparte
        },
        {
            letra: 'C',
            que: 'centro dividido por la MITAD del cuadro, no por el cuadro entero',
            espero: 'MAL: el doble de corrido, se va de cuadro. Si sale bien, las unidades son estas',
            encuadre: {
                ...base,
                centro: { horiz: base.centro.horiz * 2, vert: base.centro.vert * 2 }
            }
        }
    ];
}

/** Dónde cae el recuadro en pantalla, para poder decir qué hay que mirar. */
function dondeCae(encuadre, ancho, alto, fuenteAncho, fuenteAlto) {
    const s = encuadre.escala / 100;
    const px = ancho / 2 + encuadre.centro.horiz * ancho;
    const py = alto / 2 + encuadre.centro.vert * alto;
    const ax = fuenteAncho / 2 + encuadre.anclaje.horiz * fuenteAncho;
    const ay = fuenteAlto / 2 + encuadre.anclaje.vert * fuenteAlto;
    const r = encuadre.recorte;
    const x0 = px + s * (fuenteAncho * r.izq / 100 - ax);
    const x1 = px + s * (fuenteAncho * (1 - r.der / 100) - ax);
    const y0 = py + s * (fuenteAlto * r.arriba / 100 - ay);
    const y1 = py + s * (fuenteAlto * (1 - r.abajo / 100) - ay);
    return {
        ancho: x1 - x0,
        alto: y1 - y0,
        proporcion: (x1 - x0) / (y1 - y0),
        margenDerecho: 100 * (ancho - x1) / ancho,
        margenInferior: 100 * (alto - y1) / alto
    };
}

function fmt(n) {
    return Math.round(n * 10) / 10;
}

function main() {
    const o = opciones(process.argv.slice(2));

    const scan = courseScan.scan(o.curso);
    const cls = (scan.classes || []).find(c =>
        c.sequenceName && c.sequenceName.startsWith(`${o.clase}_`));
    if (!cls) {
        console.error(`No encontré la clase ${o.clase} en ${o.curso}.`);
        console.error(`Hay: ${(scan.classes || []).map(c => c.sequenceName).join(', ')}`);
        process.exit(1);
    }

    const plan = workspace.readJson(workspace.artifact(o.curso, cls.sequenceName, 'cutplan'));
    if (!plan || !plan.segments) {
        console.error(`La clase ${cls.sequenceName} no tiene cutplan guardado; hay que procesarla antes.`);
        process.exit(1);
    }

    // El material se mide, no se supone: el frame rate y las duraciones salen de
    // los archivos, que es de donde salen en el pipeline de verdad.
    return mediaProbe.probeClass(cls).then(() => {
        const fps = cls.fps || plan.fps || 30;
        const ancho = cls.width || 1920;
        const alto = cls.height || 1080;
        const camara = (cls.videos || [])[plan.viewMap ? plan.viewMap.PV || 0 : 0] || {};
        const medidas = {
            ancho, alto,
            fuenteAncho: camara.width || ancho,
            fuenteAlto: camara.height || alto
        };

        console.log(`Clase ${cls.sequenceName}`);
        console.log(`  ${fps} fps · ${ancho}×${alto} · ${plan.segments.filter(s => s.keep).length} bloques`);
        console.log('');

        // ── 1. La clase entera, con el recuadro puesto ──────────────────────
        const cut = exporter.cutTracks(cls, plan, null);
        const conRecuadro = cut.videoTracks.length > (cls.videos || []).length
            ? cut.videoTracks[cut.videoTracks.length - 1].length
            : 0;
        const claseXml = fcp.sequenceXml({
            name: `${cls.sequenceName} RECUADRO`,
            fps, width: ancho, height: alto,
            videoTracks: cut.videoTracks,
            audioTracks: cut.audioTracks,
            markers: cut.markers,
            durationSec: cut.durationSec
        });
        const rutaClase = path.join(o.salida, `${cls.sequenceName}-recuadro.xml`);
        fs.writeFileSync(rutaClase, claseXml);

        const caja = dondeCae(fcp.encuadreDelRecuadro(medidas), ancho, alto,
            medidas.fuenteAncho, medidas.fuenteAlto);
        console.log(`1) ${rutaClase}`);
        console.log(`   La clase entera. V3 lleva ${conRecuadro} clips con recuadro.`);
        console.log(`   Hay que ver: cuadrado de ${fmt(caja.ancho)}×${fmt(caja.alto)} px ` +
            `(proporción ${fmt(caja.proporcion * 100) / 100}),`);
        console.log(`   a ${fmt(caja.margenDerecho)} % del borde derecho y ${fmt(caja.margenInferior)} % del inferior,`);
        console.log('   con la cara del profesor centrada y las esquinas RECTAS y SIN sombra.');
        console.log('');

        // ── 2. Las tres variantes, una detrás de otra ───────────────────────
        // Cada tramo sale del mismo momento del material para que las tres se
        // comparen sobre la misma imagen y la diferencia sea solo el filtro.
        const pantalla = (cls.videos || [])[plan.viewMap ? plan.viewMap.R || 1 : 1] || camara;
        const unBloqueConPantalla = plan.segments.find(s => s.keep && s.cameraIndex !== 0)
            || plan.segments.find(s => s.keep);
        const desde = unBloqueConPantalla ? unBloqueConPantalla.sourceStartSec : 0;

        const lista = variantes(medidas);
        const fondo = [];
        const encima = [];
        const marcas = [];
        lista.forEach((v, i) => {
            const inicio = i * TRAMO_SEC;
            fondo.push({
                source: exporter.videoSource(pantalla, 1),
                startSec: inicio, endSec: inicio + TRAMO_SEC,
                sourceInSec: desde, enabled: true
            });
            encima.push({
                source: exporter.videoSource(camara, 0),
                startSec: inicio, endSec: inicio + TRAMO_SEC,
                sourceInSec: desde, enabled: true,
                encuadre: v.encuadre
            });
            marcas.push({
                name: v.letra,
                comment: `${v.letra}: ${v.que} — ${v.espero}`,
                startSec: inicio, endSec: inicio + TRAMO_SEC,
                color: 'yellow'
            });
        });

        const variantesXml = fcp.sequenceXml({
            name: `${cls.sequenceName} VARIANTES`,
            fps, width: ancho, height: alto,
            videoTracks: [fondo, encima],
            audioTracks: [],
            markers: marcas,
            durationSec: lista.length * TRAMO_SEC
        });
        const rutaVariantes = path.join(o.salida, `${cls.sequenceName}-variantes.xml`);
        fs.writeFileSync(rutaVariantes, variantesXml);

        console.log(`2) ${rutaVariantes}`);
        console.log(`   ${lista.length} tramos de ${TRAMO_SEC} s, con un marcador cada uno:`);
        for (const v of lista) {
            const c = dondeCae(v.encuadre, ancho, alto, medidas.fuenteAncho, medidas.fuenteAlto);
            console.log(`     ${v.letra} · ${v.que}`);
            console.log(`         debería verse: ${v.espero}`);
            console.log(`         si el filtro se aplica entero: ${fmt(c.ancho)}×${fmt(c.alto)} px, ` +
                `a ${fmt(c.margenDerecho)} % / ${fmt(c.margenInferior)} % de los bordes`);
        }
    });
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
