'use strict';
/**
 * El scroll de la lista de tomas, pegado al fondo.
 *
 * Lo que se prueba acá es la cuenta y nada más: si la vista está abajo del todo y
 * adónde hay que llevarla. El cableado —el oyente, la bandera de "estoy saltando
 * yo"— es DOM y se ejercitó a mano en el arnés.
 *
 * Importa porque el error se ve mal y tarde: una tolerancia de cero deja la lista
 * sin seguir a nadie en cuanto el navegador redondea un pixel, y una tolerancia
 * de cincuenta le arranca la lectura a quien subió dos renglones. Los dos casos
 * aparecen recién con la clase corriendo, que es cuando ya no se puede mirar.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** Las cuatro medidas, escritas cortas. */
function mide(arriba, alto, largo, finDeLaLista) {
    return { arriba, alto, largo, finDeLaLista: finDeLaLista == null ? largo : finDeLaLista };
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const pegado = await import(src('grabar/pegado.js'));

    t.group('el scroll pegado · adónde es "el fondo"');

    t.test('el fondo es el final de la lista de tomas, no el de la columna', () => {
        // Debajo de la lista siguen las clases ya grabadas: pegarse al final de la
        // columna dejaría lo último que se dijo arriba, tapado por lo de ayer.
        t.eq(pegado.fondoDe(mide(0, 600, 4000, 2200)), 1600);
    });

    t.test('con la lista más corta que la ventana, el fondo es el arranque', () => {
        // Cuatro tomas en una pantalla de mil: no hay adónde bajar. Un objetivo
        // negativo dejaría `estaPegado` en falso para siempre, o sea la lista sin
        // seguir a nadie justo cuando entra entera.
        t.eq(pegado.fondoDe(mide(0, 1000, 1000, 300)), 0);
    });

    t.test('el tope de la columna manda: no se pide más allá de lo que hay', () => {
        // La lista puede terminar más abajo que el largo scrolleable si algo de
        // arriba se plegó entre la medida y el salto. Pedir 2000 con 1400 de
        // recorrido deja el scroll en 1400 y `estaPegado` diría que no está abajo.
        t.eq(pegado.fondoDe(mide(0, 600, 2000, 3000)), 1400);
    });

    t.group('el scroll pegado · el umbral');

    t.test('la tolerancia es de ocho píxeles', () => {
        // Fijado a propósito: es el doble del error que acumulan tres medidas
        // redondeadas con el zoom en 200%, y menos de la mitad de un renglón del
        // texto de una toma (13px con line-height 1.7). Cambiarlo tiene que
        // costar cambiar esta prueba, que es donde está escrito el por qué.
        t.eq(pegado.TOLERANCIA, 8);
    });

    t.test('abajo del todo está pegado', () => {
        t.ok(pegado.estaPegado(mide(1600, 600, 4000, 2200)));
    });

    t.test('a siete píxeles del fondo sigue pegado: eso es redondeo, no lectura', () => {
        t.ok(pegado.estaPegado(mide(1593, 600, 4000, 2200)));
    });

    t.test('a nueve ya no: alguien subió', () => {
        t.eq(pegado.estaPegado(mide(1591, 600, 4000, 2200)), false);
    });

    t.test('subir un renglón desengancha', () => {
        // El caso que de verdad importa: 22px es un renglón del texto de una toma,
        // y quien subió uno está leyendo. Un repintado no puede traerlo de vuelta.
        t.eq(pegado.estaPegado(mide(1578, 600, 4000, 2200)), false);
    });

    t.test('haber bajado de más también cuenta como pegado', () => {
        // Con el rebote del trackpad `scrollTop` pasa del objetivo por un rato.
        t.ok(pegado.estaPegado(mide(1650, 600, 4000, 2200)));
    });

    t.test('la lista corta está pegada sin haber tocado nada', () => {
        // Entrar al paso es mirar lo que está pasando ahora, y con tres tomas eso
        // es el arranque: si acá diera "no pegado", la primera toma que desborde
        // la pantalla no aparecería sola.
        t.ok(pegado.estaPegado(mide(0, 1000, 1000, 300)));
    });

    t.test('la tolerancia se puede pedir distinta, y cero es exacto', () => {
        // No hay ninguna pantalla que la pida así; está para poder mostrar en una
        // prueba qué pasaba antes de tenerla.
        t.eq(pegado.estaPegado(mide(1599, 600, 4000, 2200), 0), false,
            'a un pixel del fondo, sin tolerancia, la lista se desengancha sola');
        t.ok(pegado.estaPegado(mide(1599, 600, 4000, 2200)), 'con la puesta, no');
    });
};
