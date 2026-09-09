'use strict';
/**
 * El temario del CD y la medición de su cobertura.
 *
 * Lo que se prueba acá es todo lo que decide sin preguntarle a nadie: cómo se
 * parte la lista pegada, cuándo hace falta llamar al modelo y qué se hace con lo
 * que el modelo contesta. La consulta en sí se inyecta —un `ai` de mentira que
 * devuelve lo que la prueba quiera—, así que la suite no necesita proveedor ni
 * red y corre igual en una Mac sin Ollama.
 *
 * El caso que más importa es el de la respuesta basura: el panel corre en medio
 * de una grabación, y un modelo local chico contestando cualquier cosa no puede
 * dejar objetivos cubiertos que nadie cubrió.
 *
 * El último grupo es el que sí toca el disco, y no puede no tocarlo: la lista se
 * hereda de la clase anterior leyendo su archivo, así que lo único que prueba de
 * verdad esa herencia es una carpeta con clases adentro.
 */

const temario = require('../engine/temario');
const grabacion = require('../engine/grabacion');
const notasXml = require('../engine/notas-xml');
const workspace = require('../engine/workspace');
const os = require('os');
const path = require('path');
const fs = require('fs');

/** Una toma como la que hay en el estado, con su texto escrito cómodo. */
function toma(id, texto, extra) {
    const palabras = texto.split(' ').map((p, i) => ({ t: 1000 + id * 100000 + i * 400, texto: p }));
    return Object.assign({
        id,
        descartada: false,
        inMs: 1000 + id * 100000,
        outMs: 1000 + id * 100000 + palabras.length * 400,
        palabras
    }, extra || {});
}

/** Un proveedor de mentira: contesta lo que se le diga y anota qué se le pidió. */
function modelo(respuesta) {
    const pedidos = [];
    return {
        model: 'modelo-de-prueba',
        pedidos,
        ask: async params => {
            pedidos.push(params);
            return typeof respuesta === 'function' ? respuesta(params) : respuesta;
        }
    };
}

module.exports = t => {

    t.group('temario · partir la lista que pega el CD');

    t.test('un renglón por tema', () => {
        const o = temario.partir('Explicar qué es un prompt\nMostrar el panel de contexto\nHacer el ejercicio');
        t.eq(o.length, 3);
        t.eq(o[0].texto, 'Explicar qué es un prompt');
        t.eq(o[2].n, 3, 'se numeran desde 1 y en el orden que trajo la lista');
    });

    t.test('viñetas de todos los sabores', () => {
        // Cada herramienta de la que se copia usa la suya, y llegan mezcladas
        // cuando el CD armó la lista pegando de dos lados.
        const o = temario.partir('- Contexto acotado\n• El archivo de reglas\n* Pruebas antes que código\n– Cierre');
        t.eq(o.length, 4);
        t.deep(o.map(x => x.texto),
            ['Contexto acotado', 'El archivo de reglas', 'Pruebas antes que código', 'Cierre']);
    });

    t.test('numerada, con punto, paréntesis o guion', () => {
        const o = temario.partir('1. Uno\n2) Dos\n3 - Tres\n(4) Cuatro');
        t.deep(o.map(x => x.texto), ['Uno', 'Dos', 'Tres', 'Cuatro']);
    });

    t.test('un año adelante no es una numeración', () => {
        // El límite de dos dígitos es lo que separa "12. tema" de "2024 - el
        // año…": con más dígitos permitidos, el objetivo perdía su primera
        // palabra y quedaba medido contra un texto que no era el suyo.
        t.eq(temario.partir('2024 - el año que cambió todo')[0].texto, '2024 - el año que cambió todo');
    });

    t.test('un párrafo de corrido se parte por sus frases', () => {
        const o = temario.partir('Hay que explicar el contexto. Después mostrar las reglas. Y cerrar con el ejercicio.');
        t.eq(o.length, 3);
        t.eq(o[1].texto, 'Después mostrar las reglas');
    });

    t.test('un párrafo con punto y coma se parte por ahí', () => {
        const o = temario.partir('Explicar el contexto; mostrar las reglas; cerrar con el ejercicio');
        t.deep(o.map(x => x.texto), ['Explicar el contexto', 'mostrar las reglas', 'cerrar con el ejercicio']);
    });

    t.test('las viñetas en una sola línea también se parten', () => {
        const o = temario.partir('• Contexto • Reglas • Ejercicio');
        t.deep(o.map(x => x.texto), ['Contexto', 'Reglas', 'Ejercicio']);
    });

    t.test('un tema solo sigue siendo un tema', () => {
        // Una frase sin puntuación no se puede partir por nada, y partirla mal
        // sería medir contra media idea.
        const o = temario.partir('Explicar por qué conviene dar contexto acotado');
        t.eq(o.length, 1);
        t.eq(o[0].texto, 'Explicar por qué conviene dar contexto acotado');
    });

    t.test('el renglón que anuncia la lista no es un objetivo', () => {
        const o = temario.partir('Objetivos de la clase:\n- Contexto\n- Reglas');
        t.deep(o.map(x => x.texto), ['Contexto', 'Reglas']);
    });

    t.test('los renglones vacíos y los espacios de sobra no cuentan', () => {
        const o = temario.partir('\n\n-   Contexto   acotado  \n\n\n-\n- Reglas\n  \n');
        t.deep(o.map(x => x.texto), ['Contexto acotado', 'Reglas']);
    });

    t.test('lo mismo dos veces es un pegado repetido, no dos objetivos', () => {
        const o = temario.partir('- Contexto acotado\n- Reglas\n- contexto ACOTADO.');
        t.eq(o.length, 2, 'la comparación no mira mayúsculas ni el punto final');
    });

    t.test('pegar nada no deja objetivos', () => {
        t.eq(temario.partir('').length, 0);
        t.eq(temario.partir(null).length, 0);
        t.eq(temario.partir('   \n  \n').length, 0);
    });

    t.test('una lista interminable se corta y un objetivo larguísimo se recorta', () => {
        const muchos = Array.from({ length: 60 }, (_x, i) => `- Tema número ${i}`).join('\n');
        t.eq(temario.partir(muchos).length, temario.MAXIMO);
        const largo = temario.partir(`- ${'palabra '.repeat(200)}`);
        t.eq(largo[0].texto.length, temario.LARGO_MAXIMO);
    });

    t.group('temario · cuándo se mide');

    const OBJETIVOS = temario.partir('- Contexto acotado\n- El archivo de reglas');
    const CERRADA = toma(1, 'Hoy vamos a ver cómo se acota el contexto del proyecto');

    t.test('sin objetivos no se mide nada', () => {
        t.eq(temario.hayQueMedir({ objetivos: [], tomas: [CERRADA] }), false);
    });

    t.test('con objetivos y una toma cerrada, se mide', () => {
        t.eq(temario.hayQueMedir({ objetivos: OBJETIVOS, tomas: [CERRADA] }), true);
    });

    t.test('la toma abierta no dispara la medición', () => {
        // Su texto es el del ciclo liviano, el descartable: se reemplaza entero
        // cuando la toma cierra. Medir contra él es medir contra un texto que no
        // va a existir, y encima cuesta una consulta por ciclo de tres segundos.
        const abierta = toma(1, 'Hoy vamos a ver', { outMs: null });
        t.eq(temario.hayQueMedir({ objetivos: OBJETIVOS, tomas: [abierta] }), false);
    });

    t.test('una toma descartada no cuenta', () => {
        const tirada = toma(1, 'Hoy vamos a ver el contexto', { descartada: true });
        t.eq(temario.hayQueMedir({ objetivos: OBJETIVOS, tomas: [tirada] }), false);
    });

    t.test('con la medición al día no se vuelve a preguntar', () => {
        const cobertura = { huella: temario.huella(OBJETIVOS, [CERRADA]) };
        t.eq(temario.hayQueMedir({ objetivos: OBJETIVOS, tomas: [CERRADA], cobertura }), false,
            'entre toma y toma la respuesta no puede cambiar');
    });

    t.test('una toma nueva vuelve a mover la huella', () => {
        const cobertura = { huella: temario.huella(OBJETIVOS, [CERRADA]) };
        const tomas = [CERRADA, toma(2, 'Ahora el archivo de reglas en la raíz del proyecto')];
        t.eq(temario.hayQueMedir({ objetivos: OBJETIVOS, tomas, cobertura }), true);
    });

    t.test('releer una toma con el modelo grande también la mueve', () => {
        // Una toma se relee al cerrar y su texto cambia entero. Con la huella
        // hecha solo de ids, la primera medición quedaba pegada al texto del
        // ciclo liviano y no se rehacía nunca.
        const cobertura = { huella: temario.huella(OBJETIVOS, [toma(1, 'Hoy vamos')]) };
        t.eq(temario.hayQueMedir({ objetivos: OBJETIVOS, tomas: [CERRADA], cobertura }), true);
    });

    t.test('cambiar la lista invalida la medición aunque no haya tomas nuevas', () => {
        const cobertura = { huella: temario.huella(OBJETIVOS, [CERRADA]) };
        const otros = temario.partir('- Contexto acotado\n- El archivo de reglas\n- Las pruebas');
        t.eq(temario.hayQueMedir({ objetivos: otros, tomas: [CERRADA], cobertura }), true);
    });

    t.test('mientras se está midiendo no se largan dos consultas juntas', () => {
        // El caso de verdad: se cierra una toma mientras la anterior se mide.
        // Quien llama vuelve a preguntar al terminar, con la huella ya movida.
        t.eq(temario.hayQueMedir({ objetivos: OBJETIVOS, tomas: [CERRADA], midiendo: true }), false);
    });

    t.group('temario · lo que se le pide al modelo');

    t.test('van los objetivos numerados y las tomas con su número', () => {
        const p = temario.armarPrompt(OBJETIVOS, [CERRADA, toma(4, 'El archivo de reglas va en la raíz')]);
        t.ok(p.includes('[1] Contexto acotado'), 'el objetivo con su número');
        t.ok(p.includes('TOMA 1:'), 'la toma con su id, que es el que se pide de vuelta');
        t.ok(p.includes('TOMA 4:'), 'el id de la toma, no su posición en la lista');
        t.ok(p.includes('se acota el contexto'), 'y lo que se dijo en ella');
    });

    t.test('las tomas descartadas no se le muestran', () => {
        const tirada = toma(9, 'Esto quedó afuera de la clase', { descartada: true });
        const p = temario.armarPrompt(OBJETIVOS, [CERRADA, tirada]);
        t.ok(!p.includes('quedó afuera'), 'lo descartado no puede cubrir un objetivo');
    });

    t.group('temario · validar lo que contesta');

    const TOMAS = [CERRADA, toma(2, 'El archivo de reglas va en la raíz del proyecto')];

    t.test('una respuesta buena se lee tal cual', () => {
        const medidos = temario.validar({
            objetivos: [
                { n: 1, cubierto: true, toma: 1, porque: 'Lo explicó al arrancar.' },
                { n: 2, cubierto: false, toma: null, porque: 'Todavía no lo nombró.' }
            ]
        }, OBJETIVOS, TOMAS);
        t.eq(medidos.length, 2);
        t.eq(medidos[0].cubierto, true);
        t.eq(medidos[0].toma, 1);
        t.eq(medidos[1].cubierto, false);
        t.eq(medidos[1].porque, 'Todavía no lo nombró.');
        t.eq(medidos[0].texto, 'Contexto acotado', 'el texto sale de la lista, no del modelo');
    });

    t.test('"sí" no es true', () => {
        // `Boolean("no")` es true, así que aceptar cualquier valor verdadero
        // dejaba objetivos cubiertos porque el modelo había escrito que no.
        const medidos = temario.validar({
            objetivos: [{ n: 1, cubierto: 'sí', toma: 1 }, { n: 2, cubierto: 'no', toma: null }]
        }, OBJETIVOS, TOMAS);
        t.eq(medidos[0].cubierto, false);
        t.eq(medidos[1].cubierto, false);
    });

    t.test('una toma que no existe no tira la cobertura, pero no se muestra', () => {
        // El modelo pudo leer bien y numerar mal. Se conserva el "cubierto" y se
        // pierde el dato accionable, que es lo honesto.
        const medidos = temario.validar({
            objetivos: [{ n: 1, cubierto: true, toma: 77, porque: 'Lo dijo.' }]
        }, OBJETIVOS, TOMAS);
        t.eq(medidos[0].cubierto, true);
        t.eq(medidos[0].toma, null);
    });

    t.test('un objetivo que no está en la lista se descarta', () => {
        const medidos = temario.validar({
            objetivos: [{ n: 9, cubierto: true, toma: 1 }, { n: 1, cubierto: true, toma: 1 }]
        }, OBJETIVOS, TOMAS);
        t.eq(medidos.length, 2, 'los de la lista y nada más');
        t.eq(medidos[0].cubierto, true);
        t.eq(medidos[1].cubierto, false, 'el 2 no lo contestó: queda sin cubrir');
    });

    t.test('el objetivo que el modelo se saltea queda sin cubrir y sin motivo', () => {
        const medidos = temario.validar({ objetivos: [{ n: 1, cubierto: true, toma: 1 }] }, OBJETIVOS, TOMAS);
        t.eq(medidos[1].cubierto, false);
        t.eq(medidos[1].porque, null, 'no se inventa un motivo que el modelo no dio');
    });

    t.test('basura entera se descarta y no se mide', () => {
        // Lo que devuelve un modelo local chico cuando se pierde. Cada uno de
        // estos dejaba el panel roto o con datos inventados.
        for (const basura of [null, {}, { objetivos: null }, { objetivos: [] }, { objetivos: 'sí' },
            { objetivos: [null, 'texto', 7] }, { hallazgos: [{ n: 1, cubierto: true }] },
            { objetivos: [{ n: 'primero', cubierto: true }] }]) {
            t.eq(temario.validar(basura, OBJETIVOS, TOMAS), null, `con ${JSON.stringify(basura)}`);
        }
    });

    t.test('sin objetivos no hay nada que validar', () => {
        t.eq(temario.validar({ objetivos: [{ n: 1, cubierto: true }] }, [], TOMAS), null);
    });

    t.group('temario · medir');

    t.test('la medición buena trae la cuenta y la huella hecha', async () => {
        const ai = modelo({
            objetivos: [
                { n: 1, cubierto: true, toma: 1, porque: 'Lo explicó al arrancar.' },
                { n: 2, cubierto: false, toma: null, porque: 'Falta.' }
            ]
        });
        const r = await temario.medir({ objetivos: OBJETIVOS, tomas: TOMAS, ai });
        t.eq(r.error, undefined);
        t.eq(r.cobertura.como, 'ia');
        t.eq(r.cobertura.cubiertos, 1);
        t.eq(r.cobertura.faltan, 1);
        t.eq(r.cobertura.modelo, 'modelo-de-prueba');
        t.eq(r.cobertura.huella, temario.huella(OBJETIVOS, TOMAS),
            'la huella es la del material medido: es lo que evita medir dos veces lo mismo');
    });

    t.test('el techo de respuesta crece con la lista', async () => {
        const ai = modelo({ objetivos: [{ n: 1, cubierto: true, toma: 1 }] });
        await temario.medir({ objetivos: OBJETIVOS, tomas: TOMAS, ai });
        t.eq(ai.pedidos[0].numPredict, temario.DEFAULTS.base + 2 * temario.DEFAULTS.porObjetivo);
    });

    t.test('un proveedor que falla no deja cobertura inventada', async () => {
        const r = await temario.medir({
            objetivos: OBJETIVOS, tomas: TOMAS, ai: modelo({ error: 'el modelo no contestó a tiempo' })
        });
        t.eq(r.cobertura, undefined, 'no hay medición');
        t.eq(r.error, 'el modelo no contestó a tiempo', 'y se dice por qué, tal cual');
    });

    t.test('una respuesta ilegible se reporta como tal', async () => {
        const r = await temario.medir({ objetivos: OBJETIVOS, tomas: TOMAS, ai: modelo({ vaya: 'a saber' }) });
        t.eq(r.cobertura, undefined);
        t.ok(r.error.includes('no se pudo leer'));
    });

    t.test('sin proveedor se dice, y se ofrece la aproximación por palabras', async () => {
        const r = await temario.medir({ objetivos: OBJETIVOS, tomas: TOMAS, ai: null });
        t.ok(r.error.includes('No hay un modelo'), 'el panel tiene que decir la verdad');
        t.eq(r.cobertura.como, 'palabras', 'y marcada, para que se dibuje como aproximación');
    });

    t.test('sin tomas cerradas no se gasta una consulta', async () => {
        const ai = modelo({ objetivos: [] });
        const r = await temario.medir({ objetivos: OBJETIVOS, tomas: [], ai });
        t.eq(ai.pedidos.length, 0);
        t.ok(r.error.includes('ninguna toma cerrada'));
    });

    t.group('temario · el respaldo por palabras');

    t.test('encuentra el objetivo dicho con sus propias palabras', () => {
        const c = temario.porPalabras(
            temario.partir('- El archivo de reglas del proyecto'),
            [toma(3, 'Vamos a crear el archivo de reglas en la raíz del proyecto')]);
        t.eq(c.cubiertos, 1);
        t.eq(c.objetivos[0].toma, 3);
    });

    t.test('y no encuentra el que se dijo con otras, que es su límite', () => {
        // Es justo la razón de usar un modelo: "el contexto acotado" queda
        // cubierto por "si le das demasiado, se pierde", donde no hay ni una
        // palabra en común. El respaldo se dibuja como aproximación por esto.
        const c = temario.porPalabras(
            temario.partir('- Explicar el contexto acotado'),
            [toma(1, 'Si le das demasiado, se pierde y toca cosas que nadie le pidió')]);
        t.eq(c.cubiertos, 0);
        t.eq(c.como, 'palabras');
    });

    t.group('temario · el que hereda la clase nueva');

    /**
     * Heredar es un `find` sobre `grabacion.listar`, y se escribió confiando en
     * que esa lista viene de la clase más nueva a la más vieja. Esa confianza
     * nunca se había ejecutado: si el orden fuera el del disco, una clase nueva
     * arrancaría con la lista de objetivos de cualquier otra y mediría contra el
     * temario equivocado sin decir una palabra —que es la peor forma de fallar
     * que tiene esto—. Por eso las clases se escriben en archivos de verdad y el
     * orden se fija desde afuera, con el reloj peleado contra el disco.
     */
    function claseEnDisco(dir, secuencia, clase, ceroMs, texto) {
        workspace.writeJson(workspace.notasArchivos(dir, secuencia).json, notasXml.sidecar({
            secuencia,
            clase,
            ceroMs,
            curso: 'curso',
            tomas: [],
            temario: texto == null ? null : {
                texto,
                objetivos: temario.partir(texto),
                origen: 'pegado',
                // Una medición hecha: es lo que NO tiene que viajar a la clase
                // siguiente, porque lo medido es de la clase que se midió.
                cobertura: {
                    como: 'ia', cubiertos: 2, faltan: 0, objetivos: [],
                    medidoEn: '2026-09-08T13:00:00.000Z'
                },
                fallo: null
            }
        }));
    }

    /** Arranca una clase nueva en una carpeta con esas clases, y devuelve su temario. */
    function temarioAlEmpezar(clases) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-herencia-'));
        try {
            for (const c of clases) claseEnDisco(dir, ...c);
            return grabacion.iniciar({ dir, clase: 9, curso: 'curso', sinReloj: true }).temario;
        } finally {
            grabacion.apagar();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    const BASE = Date.UTC(2026, 8, 8, 13, 0, 0);
    const HORA = 3600000;

    t.test('la clase nueva nace con la lista de la anterior, y sin su cobertura', () => {
        const heredado = temarioAlEmpezar([
            ['01_c_2026-09-08_13-00-00', 1, BASE, '- Contexto acotado\n- El archivo de reglas']
        ]);
        t.deep(heredado.objetivos.map(o => o.texto), ['Contexto acotado', 'El archivo de reglas']);
        t.eq(heredado.origen, 'heredado', 'y se sabe que no la pegó nadie en esta clase');
        t.eq(heredado.cobertura, null, 'lo medido es de la clase que se midió');
    });

    t.test('con varias listas, la que se hereda es la de la clase más reciente', () => {
        const heredado = temarioAlEmpezar([
            ['01_c_2026-09-08_13-00-00', 1, BASE, '- la de la mañana'],
            ['02_c_2026-09-08_16-00-00', 2, BASE + 3 * HORA, '- la de la tarde']
        ]);
        t.deep(heredado.objetivos.map(o => o.texto), ['la de la tarde']);
    });

    t.test('y el orden lo pone el reloj, no el orden en que estén en el disco', () => {
        // Escritas al revés a propósito, y con números de clase que también van al
        // revés: leyendo el directorio tal cual, el primer temario que aparece es
        // el de la mañana. Es la vuelta que esto puede dar sin que nadie se entere.
        const heredado = temarioAlEmpezar([
            ['09_c_2026-09-08_09-00-00', 9, BASE - 4 * HORA, '- la de la mañana'],
            ['01_c_2026-09-08_18-00-00', 1, BASE + 5 * HORA, '- la de la tarde']
        ]);
        t.deep(heredado.objetivos.map(o => o.texto), ['la de la tarde']);
    });

    t.test('si la última no tiene lista, se busca hacia atrás hasta encontrar una', () => {
        // El CD entrega una lista para el día. Que una clase del medio se haya
        // grabado sin pegarla no puede apagar la validación de las que siguen.
        const heredado = temarioAlEmpezar([
            ['01_c_2026-09-08_13-00-00', 1, BASE, '- la del día'],
            ['02_c_2026-09-08_16-00-00', 2, BASE + 3 * HORA, null]
        ]);
        t.deep(heredado.objetivos.map(o => o.texto), ['la del día']);
    });

    t.test('en una carpeta sin ninguna lista, la clase nueva arranca sin temario', () => {
        t.eq(temarioAlEmpezar([['01_c_2026-09-08_13-00-00', 1, BASE, null]]), null);
        t.eq(temarioAlEmpezar([]), null, 'y en una carpeta vacía tampoco se inventa nada');
    });
};
