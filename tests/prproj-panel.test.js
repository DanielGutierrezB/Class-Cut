'use strict';
/**
 * El panel de proyecto: los bins, los colores y la poda de la plantilla.
 *
 * **Todo esto se probó primero contra el proyecto que el editor armó a mano** —
 * importó el curso en Premiere, lo acomodó y guardó— y lo que se comprobó ahí
 * quedó anotado acá contra un proyecto de juguete, que es donde puede correr
 * siempre. Los números que aparecen (el color 7 en los bins, el 5 en las
 * secuencias, el 2 en el audio) no son elegidos: son los que tenía ese archivo.
 *
 * El juguete es chico a propósito. Lo que se prueba —que un bin vacío no lleve
 * lista, que la poda no deje colgados— no necesita un proyecto de verdad, y con
 * uno de verdad la prueba diría «pasa» sin que se pueda leer por qué.
 */

const prproj = require('../engine/prproj');
const secuencia = require('../engine/prproj-secuencia');

/**
 * Un panel de juguete: una raíz con un bin adentro, y en el bin un ítem.
 *
 * Alcanza para las tres cosas que importan: que haya un `BinProjectItem` del que
 * copiar, que la raíz tenga una lista `<Items>` que vaciar, y que abajo cuelgue
 * algo que la poda tenga que borrar.
 */
function panelDeJuguete() {
    return [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<PremiereData Version="3">',
        '\t<RootProjectItem ObjectUID="aaaaaaaa-0000-4000-8000-000000000001" ClassID="c1" Version="1">',
        '\t\t<ProjectItem Version="1">',
        '\t\t\t<Node Version="1">',
        '\t\t\t\t<Properties Version="1">',
        '\t\t\t\t</Properties>',
        '\t\t\t\t<ID>1000000</ID>',
        '\t\t\t</Node>',
        '\t\t\t<Name>Root Bin</Name>',
        '\t\t</ProjectItem>',
        '\t\t<ProjectItemContainer Version="1">',
        '\t\t\t<Items Version="1">',
        '\t\t\t\t<Item Index="0" ObjectURef="aaaaaaaa-0000-4000-8000-000000000002"/>',
        '\t\t\t</Items>',
        '\t\t</ProjectItemContainer>',
        '\t</RootProjectItem>',
        '\t<BinProjectItem ObjectUID="aaaaaaaa-0000-4000-8000-000000000002" ClassID="c2" Version="1">',
        '\t\t<ProjectItem Version="1">',
        '\t\t\t<Node Version="1">',
        '\t\t\t\t<Properties Version="1">',
        '\t\t\t\t\t<Column.PropertyText.Label>BE.Prefs.LabelColors.3</Column.PropertyText.Label>',
        '\t\t\t\t</Properties>',
        '\t\t\t</Node>',
        '\t\t\t<Name>lo que traía la plantilla</Name>',
        '\t\t</ProjectItem>',
        '\t\t<ProjectItemContainer Version="1">',
        '\t\t\t<Items Version="1">',
        '\t\t\t\t<Item Index="0" ObjectURef="aaaaaaaa-0000-4000-8000-000000000003"/>',
        '\t\t\t</Items>',
        '\t\t</ProjectItemContainer>',
        '\t</BinProjectItem>',
        '\t<ClipProjectItem ObjectUID="aaaaaaaa-0000-4000-8000-000000000003" ClassID="c3" Version="1">',
        '\t\t<ProjectItem Version="1">',
        '\t\t\t<Node Version="1">',
        '\t\t\t\t<Properties Version="1">',
        '\t\t\t\t</Properties>',
        '\t\t\t</Node>',
        '\t\t\t<Name>un clip de la plantilla</Name>',
        '\t\t</ProjectItem>',
        '\t</ClipProjectItem>',
        '</PremiereData>',
        ''
    ].join('\n');
}

function tallerDeJuguete() {
    return new secuencia.Taller(new prproj.Proyecto(panelDeJuguete()));
}

/** El color que quedó escrito en un ítem del panel, o null si no tiene. */
function colorDe(p, k) {
    const m = /<Column.PropertyText.Label>BE\.Prefs\.LabelColors\.(\d+)</.exec(p.contenido(k));
    return m ? Number(m[1]) : null;
}

module.exports = t => {

    t.group('prproj · la paleta de etiquetas');

    t.test('cerúleo es el 4 y rosa el 6, que es lo que Class Cut le pide al XML', () => {
        t.eq(secuencia.ETIQUETAS.Cerulean.indice, 4);
        t.eq(secuencia.ETIQUETAS.Rose.indice, 6);
    });

    t.test('los ocho colores están, con el índice de la paleta de Premiere', () => {
        t.eq(Object.keys(secuencia.ETIQUETAS).length, 8);
        const indices = Object.keys(secuencia.ETIQUETAS).map(n => secuencia.ETIQUETAS[n].indice);
        t.deep(indices.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
    });

    t.test('solo los medidos traen el entero de la línea de tiempo', () => {
        // El nombre alcanza para el panel; la línea de tiempo quiere además
        // el entero cacheado. Poner uno inventado dejaría el clip de un
        // color en el panel y de otro en la línea. Los cinco que están se
        // leyeron de proyectos de verdad; los tres que faltan no aparecen en
        // ninguno porque nadie usó todavía un clip de ese color.
        const conEntero = Object.keys(secuencia.ETIQUETAS)
            .filter(n => secuencia.ETIQUETAS[n].entero != null);
        t.deep(conEntero.sort(), ['Caribbean', 'Cerulean', 'Forest', 'Iris', 'Rose']);
    });

    t.test('el entero es BGR, o sea el RGB del color leído al revés', () => {
        // 14597935 es 0xDEBF2F: los bytes van azul, verde, rojo. Es la misma
        // convención que `pproColor` en `fcp-xml.js`, y es la que hace que
        // cerúleo sea un celeste y no un marrón.
        const rgb = entero => [entero & 255, (entero >> 8) & 255, (entero >> 16) & 255];
        t.deep(rgb(secuencia.ETIQUETAS.Cerulean.entero), [47, 191, 222]);
        t.deep(rgb(secuencia.ETIQUETAS.Rose.entero), [247, 111, 164]);
        t.deep(rgb(secuencia.ETIQUETAS.Forest.entero), [81, 184, 88]);
    });


    t.group('prproj · los bins');

    t.test('un bin recién creado no lleva lista de ítems', () => {
        // Premiere no escribe los valores por defecto: un bin vacío tiene el
        // `<ProjectItemContainer>` y nada adentro. Medido en el proyecto que
        // el editor armó a mano, en «03 Audio» y los otros tres vacíos.
        const taller = tallerDeJuguete();
        const bin = taller.crearBin('03 Audio', { orden: 2 });
        const texto = taller.proyecto.contenido(bin);
        t.eq(/<Items/.test(texto), false);
        t.eq(/<ProjectItemContainer/.test(texto), true);
    });

    t.test('y no se lleva puestos los hijos del bin del que se copió', () => {
        const taller = tallerDeJuguete();
        const bin = taller.crearBin('04 Assets');
        t.eq(taller.proyecto.refsDe(bin).length, 0);
    });

    t.test('guardar el primer ítem crea la lista que no estaba', () => {
        const taller = tallerDeJuguete();
        const p = taller.proyecto;
        const bin = taller.crearBin('01 Material');
        const otro = taller.crearBin('una clase');
        taller.guardarEn(bin, otro);
        const entradas = secuencia.entradasDeLista(p, bin, 'Items');
        t.eq(entradas.length, 1);
        t.eq(entradas[0].includes(prproj.parte(otro)[1]), true);
    });

    t.test('y el segundo se agrega al final, que es el orden que se ve', () => {
        const taller = tallerDeJuguete();
        const p = taller.proyecto;
        const bin = taller.crearBin('01 Material');
        const uno = taller.crearBin('clase 1');
        const dos = taller.crearBin('clase 2');
        taller.guardarEn(bin, uno);
        taller.guardarEn(bin, dos);
        const entradas = secuencia.entradasDeLista(p, bin, 'Items');
        t.eq(entradas.length, 2);
        t.eq(entradas[1].includes(prproj.parte(dos)[1]), true);
    });

    t.test('un bin sale mango, sin importar de qué color era el que se copió', () => {
        // El molde del juguete es lavanda (el 3). Si el color se heredara,
        // los bins del curso saldrían del color que tuviera la plantilla.
        const taller = tallerDeJuguete();
        const viejo = taller.proyecto.porClase('BinProjectItem')[0];
        t.eq(colorDe(taller.proyecto, viejo), 3);
        const bin = taller.crearBin('06 Color');
        t.eq(colorDe(taller.proyecto, bin), secuencia.ETIQUETAS.Mango.indice);
    });

    t.test('y le queda anotado dónde cae en la vista de iconos', () => {
        const taller = tallerDeJuguete();
        const bin = taller.crearBin('05 Comps', { orden: 4 });
        t.eq(/<project.icon.view.grid.order>4</.test(taller.proyecto.contenido(bin)), true);
    });


    t.group('prproj · la poda de la plantilla');

    t.test('vaciar descuelga todo de la raíz', () => {
        const taller = tallerDeJuguete();
        const p = taller.proyecto;
        const raiz = taller.raizDelPanel();
        t.deep(p.cierre([raiz], {}).length, 3);
        taller.vaciarElPanel();
        t.deep(p.cierre([raiz], {}), [raiz]);
    });

    t.test('pero no borra nada todavía, porque de ahí se clona', () => {
        // El bin de la plantilla es el molde del que salen todos los bins
        // del curso. Borrarlo al descolgar dejaría al taller sin de dónde
        // copiar en el paso siguiente.
        const taller = tallerDeJuguete();
        const p = taller.proyecto;
        taller.vaciarElPanel();
        t.eq(p.tiene(taller.moldes.bin), true);
        t.eq(typeof taller.crearBin('01 Material'), 'string');
    });

    t.test('podar al final borra lo que quedó sin colgar de ningún lado', () => {
        const taller = tallerDeJuguete();
        const p = taller.proyecto;
        const antes = p.claves().length;
        taller.vaciarElPanel();
        const nuevo = taller.crearBin('01 Material');
        taller.guardarEn(taller.raizDelPanel(), nuevo);
        const podados = taller.podarLaPlantilla();
        t.eq(podados, 2);
        t.eq(p.porNombre('BinProjectItem', 'lo que traía la plantilla') || null, null);
        t.eq(p.porNombre('ClipProjectItem', 'un clip de la plantilla') || null, null);
        t.eq(p.claves().length, antes - 2 + 1);
    });

    t.test('y no toca lo que el curso volvió a colgar', () => {
        const taller = tallerDeJuguete();
        const p = taller.proyecto;
        taller.vaciarElPanel();
        const bin = taller.crearBin('01 Material');
        taller.guardarEn(taller.raizDelPanel(), bin);
        // El clip de la plantilla se recicla en vez de tirarse: la poda mira
        // qué alcanza la raíz hoy, no qué había antes.
        const clip = p.porNombre('ClipProjectItem', 'un clip de la plantilla');
        taller.guardarEn(bin, clip);
        taller.podarLaPlantilla();
        t.eq(p.tiene(clip), true);
    });

    t.test('y el archivo queda sano después de podar', () => {
        // Con algo reciclado adentro, que es el caso que puede romper: si la
        // poda borrara todo lo que había antes sin mirar qué se volvió a
        // colgar, el bin nuevo quedaría apuntando a un objeto que ya no está.
        const taller = tallerDeJuguete();
        const p = taller.proyecto;
        taller.vaciarElPanel();
        const bin = taller.crearBin('01 Material');
        taller.guardarEn(taller.raizDelPanel(), bin);
        taller.guardarEn(bin, p.porNombre('ClipProjectItem', 'un clip de la plantilla'));
        taller.podarLaPlantilla();
        const v = p.verificar();
        t.deep(v.colgadas, []);
        t.deep(v.indices, []);
        t.deep(v.repetidos, []);
    });

    t.test('podar sin haber vaciado no borra nada', () => {
        const taller = tallerDeJuguete();
        t.eq(taller.podarLaPlantilla(), 0);
        t.eq(taller.proyecto.claves().length, 3);
    });
};
