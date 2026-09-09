'use strict';
/**
 * Las anidaciones del curso.
 *
 * Lo que se prueba acá es **la aritmética y el orden de las pistas**, que son
 * las dos cosas de este cambio que se rompen sin hacer ruido.
 *
 * La aritmética, porque un corte mal ubicado adentro de un nido no se ve al
 * generar: el archivo abre, el grafo cierra, el clip está y dura lo que tiene
 * que durar. Lo único que pasa es que muestra otro pedazo de la clase. Con trece
 * clases una detrás de otra, un error de una franja son cuarenta minutos de
 * corrimiento y el editor descubre que la clase seis muestra la ocho.
 *
 * El orden de las pistas, porque de él depende que el recuadro del profesor
 * quede arriba de todo. Si `SLIDE` no empuja al grabador de pantalla, el
 * recuadro queda tapado y no se ve — y tampoco se ve en el XML, porque el XML no
 * tiene nada de esto.
 *
 * Lo que NO se prueba acá es que Premiere lo abra: para eso hace falta Premiere.
 * Lo que sí se comprueba, en `prproj-curso.test.js`, es que el grafo cierre.
 */

const nidos = require('../engine/prproj-nidos');

/** Una clase de mentira, con lo poco que `franjasDe` le mira. */
function clase(nombre, duraciones) {
    const archivos = new Map();
    duraciones.forEach((duracionSeg, i) => {
        archivos.set(i, { id: i, nombre: `a${i}`, duracionSeg });
    });
    return { nombre, archivos, pistas: { video: [], audio: [] } };
}

const MIN = 60;

module.exports = t => {

    t.group('las anidaciones · dónde cae cada clase');

    t.test('la primera arranca en cero', () => {
        const { franjas } = nidos.franjasDe([clase('01', [600])]);
        t.eq(franjas.get(franjas.keys().next().value).desdeSeg, 0);
    });

    t.test('cada clase arranca después de la anterior más el aire', () => {
        const a = clase('01', [600]);
        const b = clase('02', [300]);
        const c = clase('03', [900]);
        const { franjas } = nidos.franjasDe([a, b, c]);

        t.eq(franjas.get(a).desdeSeg, 0);
        t.eq(franjas.get(b).desdeSeg, 600 + nidos.AIRE_SEG, 'la segunda, detrás de los diez minutos de la primera');
        t.eq(franjas.get(c).desdeSeg, 600 + 300 + 2 * nidos.AIRE_SEG, 'y la tercera acumula las dos franjas y los dos aires');
    });

    t.test('el aire son los cinco minutos que pidió el editor', () => {
        // El número es suyo y sirve para dos cosas: ver de un vistazo dónde
        // termina una clase, y poder estirar un clip sin comerse la de al lado.
        t.eq(nidos.AIRE_SEG, 5 * MIN);
    });

    t.test('la franja la marca la fuente más larga, no la primera', () => {
        // El Live-Mix suele durar unas centésimas más que el video. Con la
        // franja medida por el video, la cola del audio se metería en el aire de
        // la clase siguiente: el aire está para que eso no importe, pero una
        // franja que miente sobre lo que contiene es una cuenta que hay que
        // volver a hacer.
        const a = clase('01', [600, 601.5, 599]);
        const { franjas } = nidos.franjasDe([a]);
        t.eq(franjas.get(a).largoSeg, 601.5);
    });

    t.test('el largo total no cuenta el aire de después de la última', () => {
        // Una anidación termina donde termina el material, no cinco minutos más
        // tarde en negro.
        const { largoSeg } = nidos.franjasDe([clase('01', [600]), clase('02', [300])]);
        t.eq(largoSeg, 600 + nidos.AIRE_SEG + 300);
    });

    t.test('sin clases no hay largo negativo', () => {
        const { largoSeg, franjas } = nidos.franjasDe([]);
        t.eq(largoSeg, 0);
        t.eq(franjas.size, 0);
    });

    t.test('una clase sin archivos ocupa su lugar igual', () => {
        // No se saltea: si se le corriera la franja a las de atrás, un corte de
        // la clase tres apuntaría a la cuatro.
        const a = clase('01', []);
        const b = clase('02', [300]);
        const { franjas } = nidos.franjasDe([a, b]);
        t.eq(franjas.get(a).largoSeg, 0);
        t.eq(franjas.get(b).desdeSeg, nidos.AIRE_SEG, 'la de atrás sigue detrás del aire');
    });

    t.group('las anidaciones · de dónde sale cada fuente');

    t.test('la cámara es la pista uno y la pantalla la dos, por posición', () => {
        // Y no por el nombre del archivo: `export.js` escribe siempre la cámara
        // en la uno y la pantalla en la dos, y el nombre lo pone el aparato que
        // grabó, que puede llamarlas como quiera.
        const c = clase('01', [600]);
        c.pistas.video = [
            { cortes: [{ archivo: { id: 9, nombre: '2_LO_QUE_SEA.mp4' } }] },
            { cortes: [{ archivo: { id: 7, nombre: '1_OTRA_COSA.mp4' } }] }
        ];
        const f = nidos.fuentesDeVideo(c);
        t.eq(f.camara.id, 9, 'la primera pista es la cámara aunque el archivo se llame «2_»');
        t.eq(f.pantalla.id, 7);
    });

    t.test('una clase con una sola cámara no tiene pantalla, y no tira', () => {
        const c = clase('01', [600]);
        c.pistas.video = [{ cortes: [{ archivo: { id: 1 } }] }];
        const f = nidos.fuentesDeVideo(c);
        t.eq(f.camara.id, 1);
        t.eq(f.pantalla, null);
    });

    t.test('una pista sin cortes no aporta fuente', () => {
        const c = clase('01', [600]);
        c.pistas.video = [{ cortes: [] }, { cortes: [] }];
        t.eq(nidos.fuentesDeVideo(c).camara, null);
    });

    t.group('las anidaciones · cómo se llaman y de qué color van');

    t.test('los nombres son los que pidió el editor', () => {
        t.eq(nidos.NOMBRES.camara, 'CAM');
        t.eq(nidos.NOMBRES.pantalla, 'SR');
    });

    t.test('cada nido va del color que ya llevan los clips de su pista', () => {
        // Cerúleo la cámara y rosa el grabador de pantalla, que son los mismos
        // que el XML les pone a los clips. El nido y lo que hay adentro tienen
        // que decir lo mismo, o el color deja de querer decir nada.
        const fcp = require('../engine/fcp-xml');
        t.eq(nidos.ETIQUETA_DE_CAMARA, fcp.CLIP_LABELS[0]);
        t.eq(nidos.ETIQUETA_DE_PANTALLA, fcp.CLIP_LABELS[1]);
    });

    t.test('los tres colores están medidos, así que se pintan de verdad', () => {
        // `pintarCorte` no pinta con un entero inventado: dejaría el clip de un
        // color en el panel y de otro en la línea de tiempo. Los tres que usan
        // los nidos tienen que ser de los medidos, o el editor abre el proyecto
        // y ve tres nidos verdes como cualquier otra secuencia.
        const { ETIQUETAS } = require('../engine/prproj-moldes');
        t.ok(ETIQUETAS[nidos.ETIQUETA_DE_CAMARA].entero != null);
        t.ok(ETIQUETAS[nidos.ETIQUETA_DE_PANTALLA].entero != null);
        t.ok(ETIQUETAS[nidos.ETIQUETA_DE_AUDIO].entero != null);
    });

    t.group('las anidaciones · cuál de los diez canales es la mezcla');

    /** Una clase con sus pistas de audio y cuál de ellas suena. */
    const conAudio = cuales => {
        const c = clase('01', [600]);
        c.pistas.audio = cuales.map((suena, i) => ({
            cortes: [{ archivo: { id: 100 + i }, sonando: suena }]
        }));
        return c;
    };

    t.test('la mezcla es la única que suena, esté donde esté', () => {
        // `course-scan` la deja última hoy, pero eso es un orden que puede
        // cambiar. Lo que la define es el ojo prendido.
        const c = conAudio([false, false, true, false]);
        t.eq(nidos.pistaDelLiveMix(c), c.pistas.audio[2]);
    });

    t.test('y se la busca por el ojo, no por el nombre del archivo', () => {
        const c = conAudio([false, true]);
        c.pistas.audio[0].cortes[0].archivo.nombre = 'Live-Mix.wav';
        c.pistas.audio[1].cortes[0].archivo.nombre = '3_HDMI-2.wav';
        t.eq(nidos.pistaDelLiveMix(c), c.pistas.audio[1], 'gana la que suena, no la que se llama así');
    });

    t.test('con dos sonando no hay una mezcla, así que no se elige ninguna', () => {
        // Serían dos pistas abiertas, no una mezcla. Señalar una sería inventar
        // cuál de las dos es el respaldo del editor.
        t.eq(nidos.pistaDelLiveMix(conAudio([true, false, true])), null);
    });

    t.test('con ninguna sonando tampoco hay a quién señalar', () => {
        t.eq(nidos.pistaDelLiveMix(conAudio([false, false])), null);
        t.eq(nidos.pistaDelLiveMix(conAudio([])), null);
    });
};
