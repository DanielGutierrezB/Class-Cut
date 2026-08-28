'use strict';
/**
 * Que el reproductor muestre lo que el XML va a exportar, y no otra cosa.
 *
 * Todo el reproductor se apoya en esta traducción: si el mapeo se corre un
 * segundo, el editor aprueba un corte mirando un momento que no es el que se
 * exporta. Es lógica pura, así que se prueba sin abrir ninguna ventana.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** El módulo es ESM porque vive en la ventana; desde acá se importa a mano. */
async function cargar() {
    return import(pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'visor', 'pista.js')).href);
}

/** Tres bloques sueltos del original, como los deja el plan de cortes. */
function planDeEjemplo() {
    return [
        { blockIndex: 0, keep: true, sourceStartSec: 10, sourceEndSec: 20, cameraIndex: 0, view: 'PV' },
        { blockIndex: 1, keep: true, sourceStartSec: 100, sourceEndSec: 130, cameraIndex: 1, view: 'R' },
        { blockIndex: 2, keep: true, sourceStartSec: 300, sourceEndSec: 305, cameraIndex: 0, view: 'PV' }
    ];
}

module.exports = async t => {
    const pista = await cargar();

    t.group('la clase cortada como una sola línea de tiempo');

    t.test('los bloques quedan pegados uno detrás del otro', () => {
        const p = pista.construir(planDeEjemplo());
        t.eq(p.tramos.length, 3);
        t.eq(p.duracionSec, 45);
        t.eq(p.tramos[0].desdeSec, 0);
        t.eq(p.tramos[1].desdeSec, 10);
        t.eq(p.tramos[2].desdeSec, 40);
    });

    t.test('un bloque sacado no ocupa lugar ni deja hueco', () => {
        const plan = planDeEjemplo();
        plan[1].keep = false;
        const p = pista.construir(plan);
        t.eq(p.tramos.length, 2);
        t.eq(p.duracionSec, 15);
        // El tercero pasa a empezar donde terminaba el primero.
        t.eq(p.tramos[1].desdeSec, 10);
    });

    t.test('un bloque invertido se ignora en vez de romper el mapeo', () => {
        // Con duración negativa, todo lo que viene después queda corrido.
        const plan = planDeEjemplo();
        plan[1].sourceEndSec = 90;
        const p = pista.construir(plan);
        t.eq(p.tramos.length, 2);
        t.eq(p.duracionSec, 15);
    });

    t.test('la nota corregida pisa a la del marcador, sin perderla', () => {
        const plan = planDeEjemplo();
        plan[0].note = 'la del marcador';
        const p = pista.construir(plan, { notas: { 0: { note: 'la corregida' } } });
        // El overlay del reproductor y el panel leen el MISMO tramo: cuando cada
        // vista resolvía la corrección por su cuenta, una mostraba la nota nueva
        // y la otra la vieja.
        t.eq(p.tramos[0].nota, 'la corregida');
        t.eq(p.tramos[0].notaOriginal, 'la del marcador');
        t.eq(p.tramos[1].nota, p.tramos[1].notaOriginal, 'sin corrección son la misma');
    });

    t.test('sin bloques no hay nada que reproducir', () => {
        const p = pista.construir([]);
        t.eq(p.tramos.length, 0);
        t.eq(p.duracionSec, 0);
        t.eq(pista.tramoEn(p, 0), null);
    });

    t.group('de la línea final al archivo');

    t.test('el principio es el principio del primer bloque', () => {
        const p = pista.construir(planDeEjemplo());
        t.eq(pista.tramoEn(p, 0).origenSec, 10);
    });

    t.test('a mitad del segundo bloque se mira el momento correcto', () => {
        // 15 s del corte final = 5 s dentro del segundo bloque, que empieza a 100.
        const p = pista.construir(planDeEjemplo());
        const donde = pista.tramoEn(p, 15);
        t.eq(donde.origenSec, 105);
        t.eq(donde.tramo.blockIndex, 1);
    });

    t.test('el borde exacto entre dos bloques cae en el que empieza', () => {
        // Si cayera en el que termina, el reproductor saltaría dos veces.
        const p = pista.construir(planDeEjemplo());
        const donde = pista.tramoEn(p, 10);
        t.eq(donde.tramo.blockIndex, 1);
        t.eq(donde.origenSec, 100);
    });

    t.test('pasarse del final deja la aguja en el último bloque', () => {
        const p = pista.construir(planDeEjemplo());
        const donde = pista.tramoEn(p, 9999);
        t.eq(donde.tramo.blockIndex, 2);
        t.eq(donde.origenSec, 305);
    });

    t.test('un tiempo negativo no busca antes del primer bloque', () => {
        const p = pista.construir(planDeEjemplo());
        t.eq(pista.tramoEn(p, -30).origenSec, 10);
    });

    t.test('cada bloque sabe con qué cámara se ve', () => {
        const p = pista.construir(planDeEjemplo());
        t.eq(pista.tramoEn(p, 15).tramo.camara, 1);
        t.eq(pista.tramoEn(p, 41).tramo.camara, 0);
    });

    t.group('qué cámara le toca a cada bloque');

    t.test('cambiar la vista cambia la cámara sin tener que guardar', () => {
        // El `cameraIndex` del plan lo reescribe el exportador recién al
        // guardar: si el reproductor se guiara por él, pasar un bloque a R
        // mostraría todavía la cámara de PV.
        const plan = planDeEjemplo();
        plan[0].view = 'R';
        const p = pista.construir(plan, { viewMap: { PV: 0, R: 1 }, camaras: 2 });
        t.eq(p.tramos[0].camara, 1, 'la vista manda sobre el índice viejo');
    });

    t.test('sin mapa de vistas se respeta lo que trae el plan', () => {
        const p = pista.construir(planDeEjemplo(), { camaras: 2 });
        t.eq(p.tramos[1].camara, 1);
    });

    t.test('una vista desconocida va con la primera cámara', () => {
        const plan = planDeEjemplo();
        plan[0].view = 'XX';
        plan[0].cameraIndex = null;
        const p = pista.construir(plan, { viewMap: { PV: 0, R: 1 }, camaras: 2 });
        t.eq(p.tramos[0].camara, 0);
    });

    t.test('una vista que pide una cámara que no existe va con la primera', () => {
        // Una clase grabada con una sola cámara y un plan que pide dos.
        const p = pista.construir(planDeEjemplo(), { viewMap: { PV: 0, R: 1 }, camaras: 1 });
        t.eq(p.tramos[1].camara, 0);
    });

    t.group('el recuadro del profesor sobre el screen recorder');

    const conRecuadro = plan => pista.construir(plan, {
        viewMap: { PV: 0, R: 1 }, camaras: 2, vistaDelProfesor: 'PV'
    });

    t.test('un bloque de screen recorder lleva al profesor encima', () => {
        const p = conRecuadro(planDeEjemplo());
        t.eq(p.tramos[1].camara, 1, 'la pantalla va de imagen principal');
        t.eq(p.tramos[1].inset, 0, 'el profesor va en el recuadro');
    });

    t.test('un bloque del profesor no lleva recuadro', () => {
        // Sería ponerle encima un recuadro de sí mismo.
        const p = conRecuadro(planDeEjemplo());
        t.eq(p.tramos[0].inset, null);
    });

    t.test('sin pedir recuadro no hay recuadro en ningún bloque', () => {
        const p = pista.construir(planDeEjemplo(), { viewMap: { PV: 0, R: 1 }, camaras: 2 });
        t.eq(p.tramos[1].inset, null);
    });

    t.test('una clase de una sola cámara no arma recuadro', () => {
        const p = pista.construir(planDeEjemplo(), {
            viewMap: { PV: 1, R: 0 }, camaras: 1, vistaDelProfesor: 'PV'
        });
        t.eq(p.tramos[0].inset, null, 'la cámara del profesor no existe en esta clase');
    });

    t.test('si el mapa no dice cuál es el profesor, se usa la primera cámara', () => {
        const p = pista.construir(planDeEjemplo(), {
            viewMap: { R: 1 }, camaras: 2, vistaDelProfesor: 'PV'
        });
        t.eq(p.tramos[1].inset, 0);
    });

    t.group('qué bloques tienen comentario');

    // Anclados al tiempo de la GRABACIÓN, que es lo que sobrevive a mover un
    // borde: el bloque 1 va de 100 a 130 del original.
    const comentarios = [
        { sourceStartSec: 12, text: 'en el primero' },
        { sourceStartSec: 125, text: 'en el segundo' },
        { sourceStartSec: 110, text: 'también en el segundo' },
        { sourceStartSec: 200, text: 'en material que quedó afuera' }
    ];

    t.test('encuentra los que caen dentro del tramo', () => {
        const p = pista.construir(planDeEjemplo());
        t.eq(pista.comentariosEn(p.tramos[0].origenDesdeSec, p.tramos[0].origenHastaSec, comentarios).length, 1);
        t.eq(pista.comentariosEn(p.tramos[1].origenDesdeSec, p.tramos[1].origenHastaSec, comentarios).length, 2);
        t.eq(pista.comentariosEn(p.tramos[2].origenDesdeSec, p.tramos[2].origenHastaSec, comentarios).length, 0, 'nada en el tercero');
    });

    t.test('vienen en orden aunque se hayan escrito salteados', () => {
        const p = pista.construir(planDeEjemplo());
        t.deep(pista.comentariosEn(p.tramos[1].origenDesdeSec, p.tramos[1].origenHastaSec, comentarios).map(c => c.sourceStartSec), [110, 125]);
    });

    t.test('uno sobre material descartado no aparece en ningún bloque', () => {
        const p = pista.construir(planDeEjemplo());
        const total = p.tramos.reduce((n, t2) => n + pista.comentariosEn(t2.origenDesdeSec, t2.origenHastaSec, comentarios).length, 0);
        t.eq(total, 3, 'el de 200s no cuelga de ninguno');
    });

    t.test('sin comentarios, o sin tramo, devuelve la lista vacía', () => {
        const p = pista.construir(planDeEjemplo());
        t.deep(pista.comentariosEn(p.tramos[0].origenDesdeSec, p.tramos[0].origenHastaSec, []), []);
        t.deep(pista.comentariosEn(p.tramos[0].origenDesdeSec, p.tramos[0].origenHastaSec, null), []);
        t.deep(pista.comentariosEn(0, 0, comentarios), [], "un tramo sin ancho no abarca nada");
    });

    t.test('los bordes del tramo cuentan como adentro', () => {
        const p = pista.construir(planDeEjemplo());
        t.eq(pista.comentariosEn(p.tramos[0].origenDesdeSec, p.tramos[0].origenHastaSec, [{ sourceStartSec: 10 }, { sourceStartSec: 20 }]).length, 2);
    });

    t.group('dónde cae cada subtítulo dentro de un bloque');

    // En tiempo de grabación, como vienen de la transcripción. El bloque 1 va de
    // 100 a 130 del original.
    const frases = [
        { start: 95, end: 104, text: 'arranca antes de que entre el bloque' },
        { start: 104, end: 112, text: 'entera adentro' },
        { start: 112, end: 118, text: 'la del medio' },
        { start: 126, end: 140, text: 'sigue después de que salga' },
        { start: 200, end: 210, text: 'en material que quedó afuera' }
    ];

    t.test('trae las que suenan en el bloque y ninguna más', () => {
        const p = pista.construir(planDeEjemplo());
        const salen = pista.frasesEn(p.tramos[1], frases);
        t.deep(salen.map(f => f.texto), [
            'arranca antes de que entre el bloque',
            'entera adentro',
            'la del medio',
            'sigue después de que salga'
        ]);
    });

    t.test('la que cruza el borde entra recortada, no descartada', () => {
        // Descartarla dejaría el arranque del bloque sin texto justo donde el
        // editor está mirando si el corte entró bien.
        const p = pista.construir(planDeEjemplo());
        const primera = pista.frasesEn(p.tramos[1], frases)[0];
        t.eq(primera.origenDesdeSec, 100, 'se recorta al borde del bloque');
        t.eq(primera.origenHastaSec, 104);
        t.eq(primera.fraccionDesde, 0, 'y arranca pegada al principio');
        t.ok(primera.cortadaAlEntrar, 'y queda marcada como cortada');
        t.ok(!primera.cortadaAlSalir);
    });

    t.test('la del final también, por el otro lado', () => {
        const p = pista.construir(planDeEjemplo());
        const ultima = pista.frasesEn(p.tramos[1], frases)[3];
        t.eq(ultima.origenHastaSec, 130);
        t.eq(ultima.fraccionHasta, 1);
        t.ok(ultima.cortadaAlSalir);
        t.ok(!ultima.cortadaAlEntrar);
    });

    t.test('la fracción dice dónde dibujarla sobre la onda del bloque', () => {
        // El bloque dura 30 s: la frase de 112 a 118 cae del 40% al 60%.
        const p = pista.construir(planDeEjemplo());
        const medio = pista.frasesEn(p.tramos[1], frases)[2];
        t.near(medio.fraccionDesde, 0.4, 0.001);
        t.near(medio.fraccionHasta, 0.6, 0.001);
    });

    t.test('el segundo al que salta el clic es del CORTE, no de la grabación', () => {
        // Es lo que hace que hacer clic en una frase lleve la reproducción a
        // donde se la oye: el bloque 1 empieza a los 10 s del corte final.
        const p = pista.construir(planDeEjemplo());
        const medio = pista.frasesEn(p.tramos[1], frases)[2];
        t.eq(medio.desdeSec, 22, '10 del corte + 12 adentro del bloque');
        const cortada = pista.frasesEn(p.tramos[1], frases)[0];
        t.eq(cortada.desdeSec, 10, 'la recortada arranca en el borde del bloque');
    });

    t.test('vienen en orden aunque la transcripción no lo esté', () => {
        const p = pista.construir(planDeEjemplo());
        const alReves = [...frases].reverse();
        t.deep(pista.frasesEn(p.tramos[1], alReves).map(f => f.origenDesdeSec), [100, 104, 112, 126]);
    });

    t.test('una frase que solo toca el borde no cuenta', () => {
        // Termina exactamente donde el bloque empieza: no se oye nada de ella.
        const p = pista.construir(planDeEjemplo());
        t.deep(pista.frasesEn(p.tramos[1], [{ start: 90, end: 100, text: 'justo antes' }]), []);
        t.deep(pista.frasesEn(p.tramos[1], [{ start: 130, end: 140, text: 'justo después' }]), []);
    });

    t.test('sin frases, sin tramo o con tiempos ilegibles no rompe', () => {
        const p = pista.construir(planDeEjemplo());
        t.deep(pista.frasesEn(p.tramos[0], []), []);
        t.deep(pista.frasesEn(p.tramos[0], null), []);
        t.deep(pista.frasesEn(null, frases), []);
        t.deep(pista.frasesEn(p.tramos[0], [{ start: null, end: 15, text: 'sin arranque' }]), []);
    });

    t.group('avanzar de bloque en bloque');

    t.test('se salta cuando el archivo pasó el final del bloque', () => {
        const p = pista.construir(planDeEjemplo());
        const primero = p.tramos[0];
        t.ok(!pista.seTermino(primero, 19.9), 'a 19.9 todavía está adentro');
        t.ok(pista.seTermino(primero, 20), 'a 20 ya se pasó');
    });

    t.test('después del último no hay siguiente', () => {
        const p = pista.construir(planDeEjemplo());
        t.eq(pista.siguiente(p, p.tramos[0]).blockIndex, 1);
        t.eq(pista.siguiente(p, p.tramos[2]), null);
    });

    t.test('se puede saltar a un bloque por su número', () => {
        const p = pista.construir(planDeEjemplo());
        t.eq(pista.posicionDeBloque(p, 2), 40);
        t.eq(pista.posicionDeBloque(p, 99), null);
    });

    t.test('un bloque sacado no tiene a dónde saltar', () => {
        const plan = planDeEjemplo();
        plan[1].keep = false;
        const p = pista.construir(plan);
        t.eq(pista.posicionDeBloque(p, 1), null);
    });
};
