'use strict';
/**
 * Los dos relojes del bloque "La sesión".
 *
 * Miden cosas distintas y por eso están los dos: uno es lo que va a durar la
 * clase que se publica y el otro cuánto tiempo lleva el profesor frente al
 * micrófono. La cuenta se puede probar acá porque `cuentas` recibe la hora del
 * día en vez de leerla: sin eso, probar un reloj sería esperar.
 *
 * Lo que NO se prueba acá es que el tic corra —eso es un `setInterval` sobre el
 * DOM— y se verificó con la maqueta, mirando los mismos números en dos momentos.
 */

const path = require('path');
const { pathToFileURL } = require('url');

const BASE = Date.UTC(2026, 8, 8, 13, 0, 0);

/** Una toma como la que manda el motor, con los segundos contados desde el cero. */
function toma(id, desdeSec, duraSec, extra) {
    const inMs = BASE + desdeSec * 1000;
    return Object.assign({
        id,
        descartada: false,
        inMs,
        outMs: duraSec == null ? null : inMs + duraSec * 1000,
        palabras: []
    }, extra || {});
}

/** Una sesión en curso: lo único que mira `cuentas` del resumen del motor. */
function grabando(tomas, extra) {
    return Object.assign({ grabando: true, terminando: false, ceroMs: BASE, tomas }, extra || {});
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const { cuentas } = await import(src('grabar/analisis.js'));

    /** El valor de una fila, buscado por su etiqueta. */
    const fila = (estado, ahoraMs, que) => {
        const encontrada = cuentas(estado, ahoraMs).find(f => f[0] === que);
        if (!encontrada) throw new Error(`no hay ninguna fila "${que}"`);
        return encontrada[1];
    };

    t.group('la sesión · la duración de la clase se mueve mientras se graba');

    t.test('la toma abierta cuenta hasta ahora', () => {
        // Es el punto entero: sin ella la duración se quedaba quieta hasta que
        // alguien dijera "Pausa", o sea que dejaba de moverse justo durante lo
        // único que estaba pasando.
        const e = grabando([toma(1, 20, 60), toma(2, 100, null)]);
        const ahora = BASE + 130000;
        t.eq(fila(e, ahora, 'Duración de la clase'), '1:30', 'los 60 cerrados más los 30 que lleva abierta');
        t.eq(fila(e, ahora + 10000, 'Duración de la clase'), '1:40', 'diez segundos después, diez segundos más');
    });

    t.test('pero en "Quedan" no entra hasta que cierra', () => {
        // Esa fila cuenta lo que ya se puede escribir en el XML, y una toma sin
        // cerrar todavía no va (`tomasQueQuedan` en `engine/notas-vivo.js`).
        const e = grabando([toma(1, 20, 60), toma(2, 100, null)]);
        t.eq(fila(e, BASE + 130000, 'Quedan'), '1');
        t.eq(fila(e, BASE + 130000, 'Tomas'), '2');
    });

    t.test('una toma descartada no suma, esté cerrada o abierta', () => {
        // Descartar es sacarla de la clase: si siguiera contando, la duración
        // diría que la clase dura lo que se tiró.
        const e = grabando([
            toma(1, 20, 60),
            toma(2, 100, 45, { descartada: true }),
            toma(3, 160, null, { descartada: true })
        ]);
        t.eq(fila(e, BASE + 200000, 'Duración de la clase'), '1:00');
        t.eq(fila(e, BASE + 200000, 'Descartadas'), '2');
    });

    t.test('las palabras de la toma abierta también cuentan', () => {
        // Si los segundos de la toma abierta entraran y sus palabras no, el
        // ritmo se desplomaría en cada toma nada más que por estar hablando.
        const dichas = n => ({ palabras: Array.from({ length: n }, (_x, i) => ({ t: BASE + i, texto: 'x' })) });
        const e = grabando([toma(1, 0, 60, dichas(150)), toma(2, 60, null, dichas(150))]);
        t.eq(fila(e, BASE + 120000, 'Palabras por minuto'), '150', 'trescientas palabras en dos minutos');
    });

    t.group('la sesión · cuánto llevan grabando');

    t.test('se cuenta desde "Iniciar grabación" y no desde el aplauso', () => {
        // La claqueta es el cero de los timecodes de la clase, pero llega cuando
        // el director se acuerda. Lo que se pregunta acá es otra cosa.
        const e = grabando([toma(1, 130, 60)], { claqueta: { ms: BASE + 120000, confirmada: true } });
        t.eq(fila(e, BASE + 600000, 'Grabando hace'), '10:00', 'diez minutos desde el botón, no ocho desde el aplauso');
    });

    t.test('pasada la hora aparecen las horas', () => {
        // Un rodaje de una clase larga pasa la hora sin ninguna dificultad, y
        // "5:00" para cinco horas de grabación sería un número al revés.
        const e = grabando([toma(1, 60, 3960), toma(2, 4100, null)]);
        const ahora = BASE + 4200000;
        t.eq(fila(e, ahora, 'Grabando hace'), '1:10:00');
        t.eq(fila(e, ahora, 'Duración de la clase'), '1:07:40');
    });

    t.test('sin grabación no hay ningún reloj corriendo', () => {
        // Antes de empezar y mirando una clase terminada: nada que contar, y un
        // reloj andando ahí diría que se está grabando.
        t.eq(fila(null, BASE, 'Grabando hace'), '—');
        t.eq(fila(null, BASE, 'Duración de la clase'), '0:00');
        t.eq(fila(null, BASE, 'Sobrevive'), '—');

        // Y una toma que quedó sin cerrar en un estado que ya no graba tampoco
        // se pone a crecer: no hay contra qué medirla.
        const parada = grabando([toma(1, 20, 60), toma(2, 100, null)], { grabando: false });
        t.eq(fila(parada, BASE + 3600000, 'Duración de la clase'), '1:00');
        t.eq(fila(parada, BASE + 3600000, 'Grabando hace'), '—');
    });

    t.group('la sesión · cuánto de lo grabado sobrevive');

    t.test('es la clase contra el tiempo de micrófono', () => {
        // Cuarenta minutos de grabación para veintidós de clase dice cómo viene
        // la sesión mientras todavía se puede hacer algo.
        const e = grabando([toma(1, 60, 1320)]);
        t.eq(fila(e, BASE + 2400000, 'Sobrevive'), '55%');
    });

    t.test('en el primer minuto no se dice nada', () => {
        // Todavía no arrancó ninguna toma: el porcentaje salta entre 0 y 90 sin
        // querer decir nada.
        const e = grabando([toma(1, 12, null)]);
        t.eq(fila(e, BASE + 40000, 'Sobrevive'), '—');
        t.eq(fila(e, BASE + 40000, 'Grabando hace'), '0:40', 'el reloj sí, que ese ya vale');
    });
};
