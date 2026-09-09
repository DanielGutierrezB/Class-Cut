'use strict';
/**
 * Las teclas de la pantalla de Grabar.
 *
 * Casi todo lo de acá es la misma prueba dicha de varias maneras: **una tecla no
 * puede hacer nada mientras alguien escribe.** Es el error que en esta app ya
 * pasó una vez —la barra espaciadora del reproductor comiéndose los espacios de
 * un campo— y el que peor se ve: quien está escribiendo un comentario sobre una
 * toma en R aprieta la R y la toma se le va a otra vista, sin haber tocado nada
 * que se parezca a un botón.
 *
 * Lo otro que se fija es que las letras salgan de la inicial de cada vista y no
 * de una tabla escrita a mano, y qué pasa si dos vistas empezaran con la misma.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** Las cinco vistas que hay hoy, como las manda el motor. */
const VISTAS = [
    { nombre: 'PV', titulo: 'Plano del profesor' },
    { nombre: 'R', titulo: 'Cámara de la sala' },
    { nombre: 'S', titulo: 'Slides' },
    { nombre: 'MG', titulo: 'Plano general' },
    { nombre: 'X2', titulo: 'Las dos cámaras' }
];

/** Grabando, con la toma 4 abierta y nadie escribiendo. */
function grabando(campos) {
    return { escribiendo: false, grabando: true, activa: 4, vistas: VISTAS, ...campos };
}

function tecla(key, mods) {
    return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const { teclasDeVistas, queHace, tomaActiva, puedeElegirse, tomaDeLasTeclas } =
        await import(src('grabar/teclas.js'));

    t.group('las teclas de Grabar · qué letra es cada vista');

    t.test('la letra sale de la inicial del nombre de la vista', () => {
        // Es la diferencia entre un atajo que se adivina y uno que hay que
        // aprender: quien ve los botones "PV R S MG X2" ya sabe qué apretar.
        const mapa = teclasDeVistas(VISTAS);
        t.eq(mapa.get('p'), 'PV');
        t.eq(mapa.get('r'), 'R');
        t.eq(mapa.get('s'), 'S');
        t.eq(mapa.get('m'), 'MG');
    });

    t.test('X2 lleva X, que es su inicial como las otras cuatro', () => {
        // No se pidió y va igual: son cinco botones idénticos en la misma fila, y
        // que cuatro tengan tecla y el quinto no convierte un atajo que se
        // entiende solo en uno que hay que recordar con su excepción. Salió de la
        // misma regla, así que no es una tecla nueva.
        t.eq(teclasDeVistas(VISTAS).get('x'), 'X2');
    });

    t.test('las cinco vistas de hoy no chocan entre sí', () => {
        // El conflicto que había que resolver —dos que empiezan con la misma
        // letra— no existe con estos cinco nombres: MG es la única con M y X2 la
        // única con X. Si mañana entra una vista que choca, la de abajo lo dice.
        t.eq(teclasDeVistas(VISTAS).size, 5);
    });

    t.test('si dos vistas chocaran, la letra se la queda la primera', () => {
        // Y la segunda se queda sin atajo, a propósito: repartir la letra por
        // turnos haría que la misma tecla cambiara de significado según qué vista
        // tuviera puesta la toma, que es peor que no tener atajo.
        const mapa = teclasDeVistas([...VISTAS, { nombre: 'MG2', titulo: 'Otro general' }]);
        t.eq(mapa.get('m'), 'MG');
        t.eq(mapa.size, 5, 'la nueva no entra y no pisa a nadie');
    });

    t.test('una vista sin nombre no aporta ninguna tecla', () => {
        t.eq(teclasDeVistas([{ nombre: '' }, { titulo: 'sin nombre' }]).size, 0);
        t.eq(teclasDeVistas(null).size, 0);
    });

    t.group('las teclas de Grabar · cambiar la vista de la toma activa');

    t.test('la R pone la toma activa en R', () => {
        t.deep(queHace(tecla('r'), grabando()), { que: 'vista', vista: 'R', toma: 4 });
    });

    t.test('la mayúscula la escribe una persona: con Shift no es un atajo', () => {
        // Una tecla de atajo que también funciona con Shift se dispara al empezar
        // a escribir una frase en cualquier campo que todavía no tenga el foco.
        t.eq(queHace(tecla('R', { shiftKey: true }), grabando()), null);
    });

    t.test('una letra que no es de ninguna vista no hace nada', () => {
        t.eq(queHace(tecla('q'), grabando()), null);
    });

    t.test('la barra espaciadora sigue sin hacer nada acá', () => {
        // Una toma abierta o cerrada por error se deshace, pero el audio siguió
        // corriendo mientras tanto: las tomas las abren y las cierran sus
        // palabras, que es de donde salen los tiempos buenos.
        t.eq(queHace(tecla(' '), grabando()), null);
    });

    t.test('sin grabar no hay vista que cambiar', () => {
        t.eq(queHace(tecla('r'), grabando({ grabando: false })), null);
    });

    t.test('sin ninguna toma activa tampoco', () => {
        t.eq(queHace(tecla('r'), grabando({ activa: null })), null);
    });

    t.group('las teclas de Grabar · escribiendo no pasa nada');

    t.test('las letras de vista, escribiendo, son letras', () => {
        for (const k of ['p', 'r', 's', 'm', 'x']) {
            t.eq(queHace(tecla(k), grabando({ escribiendo: true })), null, `la ${k} adentro de un campo`);
        }
    });

    t.test('y Cmd-Z adentro de un campo deshace el TEXTO, no la acción anterior', () => {
        // Es lo que quien está escribiendo un comentario está esperando. Si esto
        // devolviera 'deshacer', borrar dos letras mal escritas revertiría el
        // descarte de una toma de hace cinco minutos.
        t.eq(queHace(tecla('z', { metaKey: true }), grabando({ escribiendo: true })), null);
        t.eq(queHace(tecla('z', { metaKey: true, shiftKey: true }), grabando({ escribiendo: true })), null);
    });

    t.test('Escape escribiendo tampoco cierra el margen', () => {
        // Con el campo del comentario abierto, el foco ESTÁ en el campo: si
        // Escape se resolviera acá, cerrar la caja sería imposible. Lo cierra el
        // navegador soltando el foco y después el Escape de afuera.
        t.eq(queHace(tecla('Escape'), grabando({ escribiendo: true })), null);
    });

    t.group('las teclas de Grabar · deshacer y rehacer');

    t.test('Cmd-Z deshace', () => {
        t.deep(queHace(tecla('z', { metaKey: true }), grabando()), { que: 'deshacer' });
    });

    t.test('Ctrl-Z también, que es el mismo atajo en la otra máquina', () => {
        t.deep(queHace(tecla('z', { ctrlKey: true }), grabando()), { que: 'deshacer' });
    });

    t.test('Cmd-Shift-Z rehace', () => {
        t.deep(queHace(tecla('z', { metaKey: true, shiftKey: true }), grabando()),
            { que: 'rehacer' });
    });

    t.test('la Z mayúscula sí vale con Comando: es cómo se escribe ese atajo', () => {
        // El navegador manda 'Z' cuando Shift está apretado, así que mirar la
        // letra tal cual dejaría Cmd-Shift-Z sin hacer nada.
        t.deep(queHace(tecla('Z', { metaKey: true, shiftKey: true }), grabando()),
            { que: 'rehacer' });
    });

    t.test('deshacer no necesita estar grabando: una clase se sigue mirando después', () => {
        t.deep(queHace(tecla('z', { metaKey: true }), grabando({ grabando: false, activa: null })),
            { que: 'deshacer' });
    });

    t.test('Cmd con cualquier otra letra es del sistema y no se toca', () => {
        // Cmd-R recarga la ventana y Cmd-S guarda: agarrarlas acá porque "R es
        // una vista" rompería la app entera.
        t.eq(queHace(tecla('r', { metaKey: true }), grabando()), null);
        t.eq(queHace(tecla('s', { metaKey: true }), grabando()), null);
        t.eq(queHace(tecla('m', { altKey: true }), grabando()), null);
    });

    t.group('las teclas de Grabar · cerrar el comentario abierto');

    t.test('Escape cierra el margen', () => {
        t.deep(queHace(tecla('Escape'), grabando()), { que: 'cerrar-caja' });
    });

    t.test('y funciona sin grabar: una clase leída también abre comentarios', () => {
        t.deep(queHace(tecla('Escape'), grabando({ grabando: false, activa: null })),
            { que: 'cerrar-caja' });
    });

    t.group('las teclas de Grabar · sobre qué toma actúan');

    t.test('sobre la que está grabando', () => {
        const estado = { tomas: [{ id: 1, outMs: 9 }, { id: 2, outMs: null }] };
        t.eq(tomaActiva(estado), 2);
    });

    t.test('sin ninguna abierta, sobre la última cerrada', () => {
        // "Pausa" ya cerró y el profesor todavía no retomó: la última es la que
        // quien graba tiene delante y sobre la que se está decidiendo.
        t.eq(tomaActiva({ tomas: [{ id: 1, outMs: 9 }, { id: 2, outMs: 20 }] }), 2);
    });

    t.test('una descartada nunca', () => {
        // Cambiarle la vista a algo que no va al XML no hace nada, y peor: la
        // tecla parecería no funcionar.
        const estado = { tomas: [{ id: 1, outMs: 9 }, { id: 2, outMs: 20, descartada: true }] };
        t.eq(tomaActiva(estado), 1);
    });

    t.test('una descartada abierta tampoco cuenta como la abierta', () => {
        const estado = { tomas: [{ id: 1, outMs: 9 }, { id: 2, outMs: null, descartada: true }] };
        t.eq(tomaActiva(estado), 1);
    });

    t.test('sin tomas no hay ninguna activa', () => {
        t.eq(tomaActiva({ tomas: [] }), null);
        t.eq(tomaActiva(null), null);
    });

    t.test('con todas descartadas tampoco', () => {
        t.eq(tomaActiva({ tomas: [{ id: 1, outMs: 9, descartada: true }] }), null);
    });

    t.group('las teclas de Grabar · la toma que se eligió con un clic');

    /** Cuatro tomas como las de una clase a medio grabar: la 3 descartada, la 4 abierta. */
    const CLASE = {
        tomas: [
            { id: 1, outMs: 10 },
            { id: 2, outMs: 20 },
            { id: 3, outMs: 30, descartada: true },
            { id: 4, outMs: null }
        ]
    };

    t.test('sin nadie elegido manda la abierta, o sea lo de antes', () => {
        // Es la mitad más importante: quien nunca se enteró de que se puede
        // elegir una toma sigue trabajando exactamente igual.
        t.eq(tomaDeLasTeclas(CLASE, null), 4);
    });

    t.test('elegida una toma vieja, la tecla va a esa y no a la abierta', () => {
        // El bug que esto arregla, en una línea: hacer clic en la toma 1 y
        // apretar M cambiaba la 4.
        t.eq(tomaDeLasTeclas(CLASE, 1), 1);
    });

    t.test('elegir la abierta es legítimo y no es lo mismo que no elegir nada', () => {
        // Se ve igual y hace lo mismo hoy; lo que cambia es qué pasa después. Ver
        // la prueba de la toma que cierra, más abajo.
        t.eq(tomaDeLasTeclas(CLASE, 4), 4);
    });

    t.test('una descartada no puede quedar elegida: la tecla vuelve a la abierta', () => {
        // Su tarjeta se pliega sin los botones de vista, así que la tecla
        // cambiaría algo que no se ve cambiar. Mejor que el atajo siga sirviendo
        // sobre lo que está pasando que dejarlo mudo.
        t.eq(puedeElegirse(CLASE, 3), false);
        t.eq(tomaDeLasTeclas(CLASE, 3), 4);
    });

    t.test('una eliminada tampoco: ya no hay tarjeta que marcar', () => {
        t.eq(puedeElegirse(CLASE, 9), false);
        t.eq(tomaDeLasTeclas(CLASE, 9), 4);
    });

    t.test('con la abierta cerrada, la elegida sigue siendo la elegida', () => {
        // "Pausa" cerró la toma que corría y quien había elegido la 1 para
        // arreglarle la vista no cambió de idea por eso. La elección es explícita
        // y se respeta mientras la toma exista.
        const cerrada = { tomas: CLASE.tomas.map(t => (t.id === 4 ? { ...t, outMs: 40 } : t)) };
        t.eq(tomaDeLasTeclas(cerrada, 1), 1);
    });

    t.test('y con una toma nueva abierta encima, también', () => {
        const otra = { tomas: [...CLASE.tomas.map(t => ({ ...t, outMs: t.outMs ?? 40 })), { id: 5, outMs: null }] };
        t.eq(tomaDeLasTeclas(otra, 1), 1, 'la elegida');
        t.eq(tomaDeLasTeclas(otra, null), 5, 'y sin elegir nada, la que abrió');
    });

    t.test('sin sesión no hay ninguna, elegida o no', () => {
        t.eq(puedeElegirse(null, 1), false);
        t.eq(tomaDeLasTeclas(null, 1), null);
        t.eq(tomaDeLasTeclas({ tomas: [] }, 1), null);
    });

    t.test('la elegida entra tal cual en el gesto de la tecla', () => {
        // Las dos mitades juntas: lo que `tomaDeLasTeclas` resuelve es lo que
        // `queHace` devuelve como `toma`, sin nada en medio.
        const activa = tomaDeLasTeclas(CLASE, 2);
        t.deep(queHace(tecla('s'), grabando({ activa, vistas: VISTAS })),
            { que: 'vista', vista: 'S', toma: 2 });
    });
};
