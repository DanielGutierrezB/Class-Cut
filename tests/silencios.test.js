'use strict';
/**
 * Que las pausas que se le muestran al editor sean las que hay.
 *
 * Esto decide qué bloques se marcan con aire muerto, así que un falso positivo
 * manda a revisar un corte que estaba bien y un falso negativo esconde diez
 * segundos de nada en la clase exportada. Se arma un WAV de verdad —chico— en
 * vez de simular la lectura: el detector mira bytes, y simularlos sería probar
 * la simulación.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const silencios = require('../engine/silencios');

const HZ = 8000;

/**
 * Un WAV mono de 16 bits armado con tramos de {seg, volumen}.
 * @param {Array} tramos [{seg, vol}] vol 0 es silencio, 1 es a fondo
 */
function escribirWav(destino, tramos) {
    const total = tramos.reduce((n, t) => n + Math.round(t.seg * HZ), 0);
    const datos = Buffer.alloc(total * 2);

    let i = 0;
    for (const tramo of tramos) {
        const cuantos = Math.round(tramo.seg * HZ);
        for (let n = 0; n < cuantos; n++, i++) {
            // Una onda, no ruido: un tono se parece más a una voz que un azar,
            // y sobre todo es igual en cada corrida.
            const onda = Math.sin((2 * Math.PI * 220 * i) / HZ);
            datos.writeInt16LE(Math.round(onda * tramo.vol * 32000), i * 2);
        }
    }

    const cabecera = Buffer.alloc(44);
    cabecera.write('RIFF', 0);
    cabecera.writeUInt32LE(36 + datos.length, 4);
    cabecera.write('WAVEfmt ', 8);
    cabecera.writeUInt32LE(16, 16);
    cabecera.writeUInt16LE(1, 20);
    cabecera.writeUInt16LE(1, 22);
    cabecera.writeUInt32LE(HZ, 24);
    cabecera.writeUInt32LE(HZ * 2, 28);
    cabecera.writeUInt16LE(2, 32);
    cabecera.writeUInt16LE(16, 34);
    cabecera.write('data', 36);
    cabecera.writeUInt32LE(datos.length, 40);

    fs.writeFileSync(destino, Buffer.concat([cabecera, datos]));
    return destino;
}

module.exports = t => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-silencios-'));
    const wav = nombre => path.join(carpeta, `${nombre}.wav`);

    t.group('encontrar el aire muerto en el audio');

    t.test('encuentra una pausa larga y la ubica', () => {
        // Habla 3s, se calla 6s, vuelve 3s.
        const f = escribirWav(wav('pausa'), [
            { seg: 3, vol: 1 }, { seg: 6, vol: 0 }, { seg: 3, vol: 1 }
        ]);
        const hallados = silencios.enTramo(f, {
            desdeSec: 0, hastaSec: 12, nivel: silencios.referencia(f)
        });
        t.eq(hallados.length, 1);
        t.near(hallados[0].desdeSec, 3, 0.2, 'arranca donde se calló');
        t.near(hallados[0].duracionSec, 6, 0.3);
    });

    t.test('una respiración corta no cuenta como pausa', () => {
        // Un silencio de 1s con el mínimo en 2 no puede aparecer: si apareciera,
        // media clase quedaría marcada y el aviso dejaría de significar algo.
        const f = escribirWav(wav('corta'), [
            { seg: 2, vol: 1 }, { seg: 1, vol: 0 }, { seg: 2, vol: 1 }
        ]);
        t.eq(silencios.enTramo(f, {
            desdeSec: 0, hastaSec: 5, nivel: silencios.referencia(f), minimoSec: 2
        }).length, 0);
    });

    t.test('un ruidito no parte una pausa en dos', () => {
        // Un crujido de silla en mitad de un silencio largo. Sin el puente se
        // informan dos pausas donde el editor ve una sola.
        const f = escribirWav(wav('ruidito'), [
            { seg: 2, vol: 1 },
            { seg: 4, vol: 0 }, { seg: 0.1, vol: 1 }, { seg: 4, vol: 0 },
            { seg: 2, vol: 1 }
        ]);
        const hallados = silencios.enTramo(f, {
            desdeSec: 0, hastaSec: 12.1, nivel: silencios.referencia(f)
        });
        t.eq(hallados.length, 1, 'una sola pausa, no dos');
        t.near(hallados[0].duracionSec, 8.1, 0.4);
    });

    t.test('un tramo sin silencios no inventa ninguno', () => {
        const f = escribirWav(wav('seguido'), [{ seg: 6, vol: 1 }]);
        t.eq(silencios.enTramo(f, {
            desdeSec: 0, hastaSec: 6, nivel: silencios.referencia(f)
        }).length, 0);
    });

    t.test('sin nivel de referencia no arriesga nada', () => {
        // Si el audio no se pudo leer, marcar la clase entera como silencio
        // sería peor que no marcar nada.
        const f = escribirWav(wav('sinnivel'), [{ seg: 3, vol: 0 }]);
        t.eq(silencios.enTramo(f, { desdeSec: 0, hastaSec: 3, nivel: null }).length, 0);
    });

    t.test('la clase entera se resuelve de una', () => {
        const f = escribirWav(wav('entera'), [
            { seg: 2, vol: 1 }, { seg: 5, vol: 0 }, { seg: 2, vol: 1 }
        ]);
        const r = silencios.deLaClase(f);
        t.eq(r.tramos.length, 1);
        t.eq(r.minimoSec, silencios.MINIMO_SEC);
        t.ok(r.nivel > 0, 'guarda contra qué comparó');
    });

    t.group('separar el silencio de la voz baja');

    t.test('lo que el audio marca callado pero alguien habla, no es pausa', () => {
        // El caso que casi borra la claqueta: el director habla desde lejos del
        // micrófono y en el Live-Mix eso mide igual que el silencio. El audio
        // dice "quince segundos de nada", Whisper dice que ahí se habló.
        const dicho = [
            { start: 0.2, end: 1.0, text: 'Cuando' },
            { start: 2.3, end: 3.0, text: 'estés' },
            { start: 4.1, end: 5.0, text: 'listo,' },
            { start: 11.3, end: 12.0, text: 'claqueta' }
        ];
        t.eq(silencios.hastaQueAlguienHabla([{ desdeSec: 0, hastaSec: 15.5, duracionSec: 15.5 }], dicho).length, 0);
    });

    t.test('la pausa se corta donde arranca la cuenta, no se descarta', () => {
        // El bloque 3 de la clase 1: diez segundos de nada y después "tres, dos,
        // uno". Descartarla entera perdería justo lo que hay que ver.
        const dicho = [
            { start: 250.02, end: 250.68, text: 'favor.' },
            { start: 260.76, end: 262.36, text: 'Tres,' }
        ];
        const r = silencios.hastaQueAlguienHabla(
            [{ desdeSec: 250.47, hastaSec: 260.91, duracionSec: 10.44 }], dicho
        );
        t.eq(r.length, 1);
        t.eq(r[0].hastaSec, 260.76, 'termina donde vuelve la voz');
        t.near(r[0].duracionSec, 10.29, 0.01);
    });

    t.test('una palabra que solo atraviesa la pausa no la corta', () => {
        // Whisper le cuelga a la última palabra dicha todo el silencio que
        // sigue: "Development" figura durando once segundos. Si eso contara como
        // habla, la pausa que hay que mostrar desaparecería.
        const dicho = [{ start: 250.49, end: 261.92, text: 'Development' }];
        const r = silencios.hastaQueAlguienHabla(
            [{ desdeSec: 250.5, hastaSec: 261, duracionSec: 10.5 }], dicho
        );
        t.eq(r.length, 1, 'la pausa sobrevive');
        t.eq(r[0].hastaSec, 261);
    });

    t.test('sin transcript se devuelven tal cual', () => {
        // Mejor mostrar de más que perderlas todas por no tener con qué comparar.
        const tramos = [{ desdeSec: 0, hastaSec: 15, duracionSec: 15 }];
        t.deep(silencios.hastaQueAlguienHabla(tramos, []), tramos);
        t.deep(silencios.hastaQueAlguienHabla(tramos, null), tramos);
    });

    t.test('lo que queda demasiado corto al recortar deja de ser pausa', () => {
        const dicho = [{ start: 1.0, end: 1.5, text: 'ya' }];
        t.eq(silencios.hastaQueAlguienHabla([{ desdeSec: 0, hastaSec: 6, duracionSec: 6 }], dicho).length, 0);
    });

    t.group('recortar las pausas a un bloque');

    const tramos = [{ desdeSec: 10, hastaSec: 20, duracionSec: 10 }];

    t.test('una pausa entera adentro se conserva', () => {
        t.eq(silencios.dentroDe(tramos, 5, 30)[0].duracionSec, 10);
    });

    t.test('una pausa que cruza el borde cuenta solo por lo que quedó', () => {
        // El corte empieza en el 15: los cinco segundos de antes no están en la
        // clase exportada y contarlos exageraría el aire muerto.
        t.eq(silencios.dentroDe(tramos, 15, 30)[0].duracionSec, 5);
    });

    t.test('lo que queda fuera del bloque no aparece', () => {
        t.eq(silencios.dentroDe(tramos, 30, 40).length, 0);
    });

    t.test('un resto demasiado corto deja de ser pausa', () => {
        // Solo un segundo cae adentro, y un segundo es respirar.
        t.eq(silencios.dentroDe(tramos, 19, 30).length, 0);
    });

    // Los WAV quedan en el temporal del sistema, como en el resto de la suite:
    // borrarlos acá los borraría ANTES de que corran las pruebas, que se encolan
    // y se ejecutan después de que este módulo termina.
};
