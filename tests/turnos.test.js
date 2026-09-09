'use strict';
/**
 * El mostrador de turnos de la pantalla de Grabar.
 *
 * Lo que se prueba acá es una CARRERA, así que hay que decir qué se puede probar
 * sin pantalla y qué no. Sin pantalla se puede probar la regla —de dos
 * respuestas, la vieja se tira— y se puede probar sobre la forma exacta que
 * tiene el sitio donde se usa: pedir, esperar, mirar el turno, guardar. Lo que no
 * se puede es hacer que dos respuestas del motor de verdad se crucen, porque eso
 * depende del IPC y de la suerte; eso se provoca a mano demorando una respuesta,
 * y está en `tools/probar-repintado.js`.
 *
 * Las dos últimas pruebas son el par que importa: la misma cruzada de respuestas
 * con el mostrador y sin él. Sin la segunda, la primera pasaría en verde aunque
 * el mostrador no hiciera nada.
 */

const path = require('path');
const { pathToFileURL } = require('url');

const espera = ms => new Promise(r => setTimeout(r, ms));

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const { mostrador, esDeLaQueTermino } = await import(src('grabar/turnos.js'));

    t.group('grabar · el mostrador de turnos');

    t.test('la respuesta de un pedido solo sirve', () => {
        const m = mostrador();
        t.eq(m.atrasada(m.tomar()), false);
    });

    t.test('dos pedidos que contestan en orden sirven los dos', () => {
        const m = mostrador();
        const uno = m.tomar();
        const dos = m.tomar();
        t.eq(m.atrasada(uno), false);
        t.eq(m.atrasada(dos), false);
    });

    t.test('si contestan al revés, la vieja se tira', () => {
        const m = mostrador();
        const uno = m.tomar();
        const dos = m.tomar();
        t.eq(m.atrasada(dos), false, 'la nueva manda');
        t.eq(m.atrasada(uno), true, 'y la de antes ya no sirve');
    });

    t.test('con tres en vuelo, gana la última que llegó y las otras se tiran', () => {
        const m = mostrador();
        const [uno, dos, tres] = [m.tomar(), m.tomar(), m.tomar()];
        t.eq(m.atrasada(tres), false);
        t.eq(m.atrasada(dos), true);
        t.eq(m.atrasada(uno), true);
    });

    t.test('una respuesta atrasada no atrasa a la que venía detrás', () => {
        // La vieja se tira y no deja nada movido: la que sale después de ella
        // tiene que poder guardar igual.
        const m = mostrador();
        const uno = m.tomar();
        const dos = m.tomar();
        t.eq(m.atrasada(dos), false);
        t.eq(m.atrasada(uno), true);
        t.eq(m.atrasada(m.tomar()), false, 'la siguiente sigue sirviendo');
    });

    t.test('cada mostrador cuenta sus turnos', () => {
        const uno = mostrador();
        const otro = mostrador();
        uno.tomar();
        uno.tomar();
        t.eq(otro.atrasada(otro.tomar()), false, 'el turno 1 del otro no llega tarde');
    });

    /**
     * La forma del sitio donde se usa: dos gestos sobre tomas distintas, el motor
     * los aplica en orden y las respuestas vuelven al revés. La primera que vuelve
     * es la foto de después del segundo cambio; la que llega tarde es la de antes.
     */
    async function dosGestos(conMostrador) {
        const m = mostrador();
        let pantalla = 'toma1=PV toma4=PV';
        const pedir = async (foto, tarda) => {
            const turno = m.tomar();
            await espera(tarda);
            if (conMostrador && m.atrasada(turno)) return;
            pantalla = foto;
        };
        await Promise.all([
            // El primer gesto: la toma 1 a MG. Su respuesta se demora.
            pedir('toma1=MG toma4=PV', 30),
            // El segundo: la toma 4 a S, con la 1 ya en MG del lado del motor.
            pedir('toma1=MG toma4=S', 0)
        ]);
        return pantalla;
    }

    t.test('con el mostrador, la pantalla queda con los dos cambios', async () => {
        t.eq(await dosGestos(true), 'toma1=MG toma4=S');
    });

    t.test('y sin él, el segundo cambio desaparece de la pantalla', async () => {
        // El defecto tal cual estaba: el cambio se escribió en el XML y en la
        // pantalla la toma 4 volvía a mostrar la vista de antes hasta el empujón
        // siguiente del motor.
        t.eq(await dosGestos(false), 'toma1=MG toma4=PV');
    });

    /* ─── La otra pantalla: releer la lista de clases grabadas ─────────────
     *
     * `grabadas.cargar` tiene la misma forma —pedir, esperar, mirar el turno,
     * guardar— y la misma carrera, con un agravante: son DOS viajes seguidos (los
     * ajustes y las clases) y la llaman siete caminos. El de abajo es el que se vio
     * al auditar: regenerar una clase larga avisa su avance y relee, y si mientras
     * tanto se borra otra, la releída vieja devuelve a la pantalla la clase que ya
     * no está en el disco.
     */

    /**
     * Dos releídas de la lista cruzadas: la de antes de borrar tarda más que la de
     * después. Con `conMostrador` en false es cómo estaba la pantalla.
     */
    async function dosReleidas(conMostrador) {
        const m = mostrador();
        let pantalla = ['Clase 3', 'Clase 4'];
        const releer = async (loQueHay, tarda) => {
            const turno = m.tomar();
            await espera(tarda);
            if (conMostrador && m.atrasada(turno)) return;
            pantalla = loQueHay;
        };
        await Promise.all([
            // El avance del regenerado relee la lista entera, y el disco tarda.
            releer(['Clase 3', 'Clase 4'], 30),
            // Y mientras tanto se borró la 4, que sí llega rápido.
            releer(['Clase 3'], 0)
        ]);
        return pantalla.join(' | ');
    }

    t.test('con el mostrador, la clase borrada no vuelve a la lista', async () => {
        t.eq(await dosReleidas(true), 'Clase 3');
    });

    t.test('y sin él, la releída atrasada la resucita en la pantalla', async () => {
        t.eq(await dosReleidas(false), 'Clase 3 | Clase 4');
    });

    /* ─── El aviso que llega después de terminar ───────────────────────────
     *
     * La otra mitad del mismo problema, y la que se vio en la app de verdad
     * (`tools/probar-vivo.js`): un aviso no se pide, así que no tiene turno, y el
     * que entra después de cerrar la clase la devolvía a "grabando".
     */

    t.group('grabar · el aviso de una clase que ya terminó');

    const CUAL = '02_curso_2026-09-08_15-00-00';

    t.test('sin ninguna clase cerrada, todos los avisos se dibujan', () => {
        t.eq(esDeLaQueTermino({ secuencia: CUAL, grabando: true }, null), false);
    });

    t.test('el aviso atrasado de la clase que se cerró se tira', () => {
        // Es el que dejaba la pantalla trabada: trae `grabando: true` sobre una
        // clase cuyo XML ya está escrito, y con eso «← Clases» no se enciende más.
        t.eq(esDeLaQueTermino({ secuencia: CUAL, grabando: true }, CUAL), true);
    });

    t.test('el de la clase siguiente sí se dibuja, aunque venga una cerrada atrás', () => {
        // En un día de rodaje se graban varias seguidas: una marca que fuera un sí
        // o un no dejaría muda la que empieza después.
        t.eq(esDeLaQueTermino({ secuencia: '03_curso_2026-09-08_16-00-00' }, CUAL), false);
    });

    t.test('un aviso sin estado no se confunde con uno atrasado', () => {
        t.eq(esDeLaQueTermino(null, CUAL), false);
    });
};
