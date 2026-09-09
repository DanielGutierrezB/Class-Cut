'use strict';
/**
 * Los huecos que Whisper deja sin escribir.
 *
 * Lo comprobable sin correr Whisper es dónde se decide releer y dónde no, que es
 * justamente donde está el riesgo: sobre silencio, whisper.cpp escribe créditos
 * de subtítulos que se aprendió de memoria ("CC por Antarctica Films
 * Argentina"), así que un hueco que se relee de más mete texto inventado en el
 * guion. La reja es el mapa de voz, y es esto.
 *
 * Que la relectura recupere de verdad la frase en otro idioma se midió con audio
 * real (`tools/medir-huecos.js`): 12 huecos en las catorce clases del curso.
 */

const oir = require('../engine/oir');

/** Palabras como las devuelve Whisper: pegadas, cada una empieza donde acabó la anterior. */
function pegadas(lista) {
    let t = 0;
    return lista.map(([texto, dur]) => {
        const w = { text: texto, start: t, end: t + dur };
        t += dur;
        return w;
    });
}

/** Un mapa de voz de mentira: solo sus tramos, que es lo único que se mira. */
const mapa = tramos => ({ tramos });

module.exports = t => {
    t.group('oír · dónde hay un hueco que releer');

    t.test('palabras seguidas no dejan hueco', () => {
        const words = pegadas([['Hoy', 1], ['vamos', 1], ['a', 1], ['ver', 1]]);
        t.eq(oir.huecos(words, mapa([[0, 4]])).length, 0);
    });

    t.test('un hueco corto no se mira, por más que se oiga a alguien', () => {
        const words = [
            { text: 'Hoy', start: 0, end: 1 },
            { text: 'vamos', start: 3, end: 4 }
        ];
        t.eq(oir.huecos(words, mapa([[1, 3]])).length, 0,
            'dos segundos está por debajo del listón');
    });

    t.test('un hueco largo sin voz adentro tampoco: es una pausa', () => {
        const words = [
            { text: 'Pausa.', start: 0, end: 1 },
            { text: 'Bueno,', start: 30, end: 31 }
        ];
        t.eq(oir.huecos(words, mapa([[0, 1], [30, 31]])).length, 0);
    });

    t.test('un hueco largo con voz sostenida sí, y se lee el sonido y no el hueco', () => {
        const words = [
            { text: 'Pausa.', start: 0, end: 1 },
            { text: 'Bueno,', start: 30, end: 31 }
        ];
        // Alguien habla de 12 a 16, y el resto del hueco es sala vacía.
        const hallados = oir.huecos(words, mapa([[0, 1], [12, 16], [30, 31]]));
        t.eq(hallados.length, 1);
        t.eq(hallados[0].desde, 1, 'el hueco va de palabra a palabra…');
        t.eq(hallados[0].hasta, 30);
        t.near(hallados[0].leeDesde, 11.6, 0.01, '…pero se lee solo el sonido, con su aire');
        t.near(hallados[0].leeHasta, 16.4, 0.01);
    });

    t.test('el aire que se le da al sonido no se sale del hueco', () => {
        const words = [
            { text: 'Pausa.', start: 0, end: 10 },
            { text: 'Bueno,', start: 20, end: 21 }
        ];
        const hallados = oir.huecos(words, mapa([[10, 20]]));
        t.eq(hallados.length, 1);
        t.eq(hallados[0].leeDesde, 10, 'no se relee lo que la palabra de la izquierda ya cubrió');
        t.eq(hallados[0].leeHasta, 20);
    });

    t.test('la voz tiene que ser sostenida, no un crujido cada tanto', () => {
        const words = [
            { text: 'Pausa.', start: 0, end: 1 },
            { text: 'Bueno,', start: 30, end: 31 }
        ];
        // Cuatro chasquidos de 0,2 s: 0,8 s de sonido en veintinueve de hueco.
        t.eq(oir.huecos(words, mapa([[5, 5.2], [9, 9.2], [14, 14.2], [22, 22.2]])).length, 0);
    });

    t.test('una palabra vacía no cuenta como palabra', () => {
        const words = [
            { text: 'Pausa.', start: 0, end: 1 },
            { text: '  ', start: 14, end: 15 },
            { text: 'Bueno,', start: 30, end: 31 }
        ];
        const hallados = oir.huecos(words, mapa([[0, 1], [12, 16], [30, 31]]));
        t.eq(hallados.length, 1, 'el hueco sigue siendo uno solo y no dos partidos por el vacío');
        t.eq(hallados[0].hasta, 30);
    });

    t.group('oír · lo que se rescata tiene que estar en nuestro alfabeto');

    t.test('el español y el inglés del curso pasan', () => {
        for (const texto of ['prompt', '¿Qué', 'Pausa.', 'Sous-titrage', 'vibe-codear']) {
            t.ok(oir.enNuestroAlfabeto(texto), texto);
        }
    });

    t.test('lo que no tiene letras pasa: son números y puntuación', () => {
        for (const texto of ['3,', '2,', '1.', '…']) t.ok(oir.enNuestroAlfabeto(texto), texto);
    });

    t.test('otro alfabeto no: es lo que whisper.cpp inventa sobre lo que no entiende', () => {
        // Sobre siete segundos de la clase 8, con `auto`, escribió "뒤에 가려…".
        // Pedirle el idioma del curso lo evita ahí, pero no es garantía, y un
        // guion en coreano en medio de una clase en español no vale el riesgo.
        for (const texto of ['뒤에', '가려...', '特に', 'Привет']) {
            t.ok(!oir.enNuestroAlfabeto(texto), texto);
        }
    });
};
