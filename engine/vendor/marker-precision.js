/**
 * marker-precision.js — Módulo PURO: validación de la posición de un marcador
 * contra el transcript, por ELECCIÓN entre puntos de corte reales.
 *
 * Por qué no pedirle un timecode al LLM:
 *   pedirle "¿en qué segundo va el marcador?" hace que invente números (cae a
 *   mitad de palabra, se va 40s, o repite el tiempo actual con ruido), y todo eso
 *   termina descartado por los filtros → el marcador no se mueve.
 *
 * Estrategia de este módulo:
 *   1. Se calculan los PUNTOS DE CORTE POSIBLES de forma determinística: solo
 *      fronteras entre palabras (nunca a mitad de palabra), priorizando las
 *      pausas reales y dejando opciones finas alrededor de la marca actual. Cada
 *      punto lleva un colchón de padFrames frames de aire hacia el silencio.
 *   2. Se numeran y se pintan dentro del propio transcript: "...hola [1] hoy [2]..."
 *   3. El LLM solo elige un número. No puede alucinar un tiempo, no puede
 *      cortar una palabra y el movimiento está acotado por construcción.
 *   4. Si contesta el número de la posición actual, el marcador se queda.
 *
 * Doble export: window.EPMarkerPrecision + module.exports (Node).
 */
(function(global) {
    "use strict";

    var DEFAULTS = {
        windowSec: 18,        // cuánto se mira a cada lado del marcador
        maxCandidates: 12,    // puntos numerados que ve el LLM
        nearCount: 3,         // opciones finas alrededor de la marca actual
        contextWords: 60,     // palabras del transcript que se muestran
        padFrames: 10,        // colchón de aire antes del IN y después del OUT
        fps: 25,             // se sobreescribe con el frame rate real de la secuencia
        currentTolerance: 0.3, // a esta distancia se considera "el punto actual"
        // Arranques de frase que se ofrecen como corte (`sentenceStarts`)
        sentenceReachSec: 45, // cuánto bloque se pone en juego a partir del corte
        sentenceKeepSec: 5,   // lo que el bloque conserva como mínimo
        sentenceMax: 6,       // arranques de frase que entran en la lista
        sentenceSnippetWords: 14
    };

    function opt(opts, key) {
        if (opts && opts[key] !== undefined && opts[key] !== null) return opts[key];
        return DEFAULTS[key];
    }

    function wordText(w) {
        if (!w) return "";
        var t = (w.text != null) ? w.text : w.word;
        return t == null ? "" : String(t);
    }

    function spokenWords(words) {
        var out = [];
        for (var i = 0; i < (words || []).length; i++) {
            var w = words[i];
            if (!w) continue;
            if (w.type && w.type !== "word") continue;
            if (typeof w.start !== "number" || typeof w.end !== "number") continue;
            if (!wordText(w)) continue;
            out.push(w);
        }
        out.sort(function(a, b) { return a.start - b.start; });
        return out;
    }

    function round(x) { return Math.round(x * 1000) / 1000; }

    // ─── Puntos de corte posibles ────────────────────────────

    function frameRate(opts) {
        var fps = Number(opt(opts, "fps"));
        if (!isFinite(fps) || fps <= 0) return DEFAULTS.fps;
        return fps;
    }

    /** Colchón en segundos: los frames de aire que se dejan a cada lado. */
    function padSec(opts) {
        var frames = Number(opt(opts, "padFrames"));
        if (!isFinite(frames) || frames < 0) frames = DEFAULTS.padFrames;
        return frames / frameRate(opts);
    }

    /** Premiere corta en frames, no en milisegundos: el punto cae en el frame. */
    function snapFrame(t, fps, dir) {
        var f = t * fps;
        var snapped = dir < 0 ? Math.floor(f) : Math.ceil(f);
        return Math.max(0, snapped) / fps;
    }

    /**
     * Un punto de corte vive en el silencio entre dos palabras.
     *   kind "IN":  queda ANTES de la palabra que abre el bloque
     *   kind "OUT": queda DESPUÉS de la palabra que lo cierra
     * Así una palabra nunca se parte: se incluye completa o se excluye completa.
     *
     * Además se deja un COLCHÓN de padFrames frames de aire (el corte pegado a la
     * palabra suena abrupto y se come el ataque de la primera sílaba). Si el
     * silencio disponible es más corto que el colchón, se toma todo el silencio y
     * ni un frame más: nunca se invade la palabra vecina.
     */
    function boundaryTime(prev, next, kind, opts) {
        var fps = frameRate(opts);
        var pad = padSec(opts);

        if (kind === "IN") {
            if (!next) return round(prev ? prev.end : 0);
            var lo = prev ? prev.end : 0;
            var t = Math.max(lo, next.start - pad);
            t = snapFrame(t, fps, -1);
            if (t < lo) t = snapFrame(lo, fps, 1);
            return round(Math.max(0, Math.min(t, next.start)));
        }

        if (!prev) return round(0);
        var hi = next ? next.start : (prev.end + pad);
        var o = Math.min(hi, prev.end + pad);
        o = snapFrame(o, fps, 1);
        if (o > hi) o = snapFrame(hi, fps, -1);
        return round(Math.max(prev.end, o));
    }

    /**
     * Todas las fronteras entre palabras dentro de la ventana alrededor de
     * targetTime, con el silencio que las acompaña.
     *
     * `opts.forceTimes` mete fronteras concretas aunque caigan fuera de la
     * ventana: es como entra el punto que pide la nota del CD, que puede estar
     * más lejos de lo que se mira por defecto.
     *
     * `opts.onlyForced` deja SOLO esas: cuando la frase de la nota se grabó varias
     * veces, lo único que hay que decidir es cuál de esas tomas, y con la ventana
     * completa el LLM se va a otro sitio (caso real: la frase estaba en 81.3s y
     * 98.1s y eligió 101.3s, a mitad de la frase siguiente).
     *
     * `opts.minTime`/`opts.maxTime` son el **territorio del bloque**: el borde de al
     * lado. No hay opción que valga fuera de ahí —un OUT en el bloque siguiente no es
     * un corte, es un bloque roto—, así que este límite se aplica también a las
     * forzadas: si la toma que pide la nota cae en el bloque vecino, no es una toma
     * elegible (clase 15, bloque 4).
     *
     * @returns {Array} [{time, gapSec, wordIdx}] wordIdx = palabra que sigue al corte
     */
    function boundaryPool(spoken, targetTime, kind, opts) {
        var window = opt(opts, "windowSec");
        var forced = forcedIdx(spoken, kind, opts && opts.forceTimes);
        var onlyForced = !!(opts && opts.onlyForced);
        var lo = opts && opts.minTime != null ? Number(opts.minTime) : -Infinity;
        var hi = opts && opts.maxTime != null ? Number(opts.maxTime) : Infinity;
        var pool = [];
        for (var i = 0; i <= spoken.length; i++) {
            var prev = i > 0 ? spoken[i - 1] : null;
            var next = i < spoken.length ? spoken[i] : null;
            if (!prev && !next) continue;
            // El corte de IN necesita una palabra que abra; el de OUT, una que cierre.
            if (kind === "IN" && !next) continue;
            if (kind === "OUT" && !prev) continue;

            var t = boundaryTime(prev, next, kind, opts);
            if (t < lo || t > hi) continue;
            if (!forced[i] && (onlyForced || Math.abs(t - targetTime) > window)) continue;
            var gap = (prev && next) ? Math.max(0, next.start - prev.end) : 999;
            // frontier = la frontera de palabra sin colchón. Sirve para saber si el
            // marcador ya está en este punto: el colchón desplaza `time`, la
            // frontera no.
            var frontier = kind === "IN" ? (next ? next.start : t) : (prev ? prev.end : t);
            pool.push({
                time: t, frontier: round(frontier), gapSec: round(gap),
                wordIdx: i, forced: !!forced[i]
            });
        }
        return pool;
    }

    /** wordIdx de las fronteras que hay que ofrecer siempre, dada una lista de tiempos. */
    function forcedIdx(spoken, kind, times) {
        times = times || [];
        var map = {};
        for (var t = 0; t < times.length; t++) {
            var i = frontierIndex(spoken, Number(times[t]), kind);
            if (i >= 0) map[kind === "IN" ? i : i + 1] = true;
        }
        return map;
    }

    /** Índice de la palabra cuya frontera (inicio si IN, final si OUT) cae en t. */
    function frontierIndex(spoken, t, kind) {
        if (!isFinite(t)) return -1;
        var best = -1, bestDist = Infinity;
        for (var i = 0; i < spoken.length; i++) {
            var d = Math.abs((kind === "IN" ? spoken[i].start : spoken[i].end) - t);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        return bestDist <= 0.05 ? best : -1;
    }

    /**
     * El punto de corte —con su colchón— que corresponde a una frontera de
     * palabra concreta. Es la vía para aplicar un tiempo que se decidió fuera de
     * este módulo (el ancla de la nota del CD) sin perder ni el colchón ni el
     * snap a frame.
     * @returns {object|null} {time, frontier, gapSec, wordIdx}
     */
    function boundaryAt(words, frontierTime, kind, opts) {
        var spoken = spokenWords(words);
        var i = frontierIndex(spoken, frontierTime, kind);
        if (i < 0) return null;

        var prev, next;
        if (kind === "IN") { prev = i > 0 ? spoken[i - 1] : null; next = spoken[i]; }
        else { prev = spoken[i]; next = i + 1 < spoken.length ? spoken[i + 1] : null; }

        var gap = (prev && next) ? Math.max(0, next.start - prev.end) : 999;
        return {
            time: boundaryTime(prev, next, kind, opts),
            frontier: round(kind === "IN" ? spoken[i].start : spoken[i].end),
            gapSec: round(gap),
            wordIdx: kind === "IN" ? i : i + 1
        };
    }

    /**
     * Elige qué fronteras se le ofrecen al LLM: las pausas más largas de la
     * ventana (que es donde suele estar el corte correcto) + unas cuantas
     * cercanas a la marca actual para ajustes finos.
     */
    function selectCandidates(pool, targetTime, opts) {
        var max = opt(opts, "maxCandidates");
        var near = opt(opts, "nearCount");
        if (pool.length <= max) return pool.slice(0).sort(byTime);

        var byDistance = pool.slice(0).sort(function(a, b) {
            return Math.abs(a.time - targetTime) - Math.abs(b.time - targetTime);
        });
        var byGap = pool.slice(0).sort(function(a, b) {
            if (b.gapSec !== a.gapSec) return b.gapSec - a.gapSec;
            return Math.abs(a.time - targetTime) - Math.abs(b.time - targetTime);
        });

        var picked = [];
        var used = {};
        function take(list, n) {
            for (var i = 0; i < list.length && n > 0; i++) {
                var key = list[i].wordIdx;
                if (used[key]) continue;
                used[key] = true;
                picked.push(list[i]);
                n--;
            }
        }
        // Las fronteras forzadas (lo que pide la nota del CD) entran siempre: son
        // la razón de la consulta.
        var forced = pool.filter(function(p) { return p.forced; });
        take(forced, max);
        take(byDistance, Math.min(near, Math.max(0, max - picked.length)));
        take(byGap, max - picked.length);

        return picked.sort(byTime);
    }

    function byTime(a, b) { return a.time - b.time; }

    /**
     * Puntos de corte numerados alrededor de un marcador.
     * @param {Array} words words[] del STT
     * @param {number} targetTime posición actual del marcador
     * @param {string} kind "IN" | "OUT"
     * @returns {{candidates: Array, current: number}} candidates 1-based (index),
     *          current = número del punto donde está hoy el marcador (0 si ninguno)
     */
    function buildCandidates(words, targetTime, kind, opts) {
        var spoken = spokenWords(words);
        if (spoken.length === 0) return { candidates: [], current: 0 };

        var pool = boundaryPool(spoken, targetTime, kind, opts);
        if (pool.length === 0) return { candidates: [], current: 0 };

        var selected = selectCandidates(pool, targetTime, opts);

        // El punto más cercano a la marca actual es "donde está hoy". Se mide contra
        // el tiempo con colchón y contra la frontera de palabra: el marcador puede
        // venir pegado a la palabra (primera pasada) o ya con su aire (segunda).
        var tol = opt(opts, "currentTolerance");
        var bestIdx = -1, bestDist = Infinity;
        for (var i = 0; i < selected.length; i++) {
            var d = Math.min(
                Math.abs(selected[i].time - targetTime),
                Math.abs(selected[i].frontier - targetTime)
            );
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }

        // Fronteras que la nota del CD señala: se marcan para que el prompt las
        // distinga del resto de las pausas.
        var cueTimes = (opts && opts.cueTimes) || [];
        function nearAny(times, frontier) {
            for (var q = 0; q < times.length; q++) {
                if (Math.abs(Number(times[q]) - frontier) <= 0.05) return true;
            }
            return false;
        }

        var candidates = [];
        for (var c = 0; c < selected.length; c++) {
            candidates.push({
                index: c + 1,
                time: selected[c].time,
                frontier: selected[c].frontier,
                gapSec: selected[c].gapSec,
                wordIdx: selected[c].wordIdx,
                isCurrent: (c === bestIdx && bestDist <= tol),
                isCue: nearAny(cueTimes, selected[c].frontier)
            });
        }
        return {
            candidates: candidates,
            current: (bestIdx >= 0 && bestDist <= tol) ? (bestIdx + 1) : 0
        };
    }

    // ─── Transcript con los puntos numerados ─────────────────

    /**
     * Transcript legible con los puntos de corte intercalados: "hola [1] hoy [2] ...".
     * Se recorta a contextWords palabras alrededor de la zona de candidatos.
     */
    function buildMarkedText(words, candidates, opts) {
        var spoken = spokenWords(words);
        if (spoken.length === 0 || candidates.length === 0) return "";

        var n = opt(opts, "contextWords");
        var firstIdx = candidates[0].wordIdx;
        var lastIdx = candidates[candidates.length - 1].wordIdx;
        var span = lastIdx - firstIdx;
        var pad = Math.max(4, Math.floor((n - span) / 2));
        var from = Math.max(0, firstIdx - pad);
        var to = Math.min(spoken.length, lastIdx + pad);

        var marks = {};
        for (var c = 0; c < candidates.length; c++) {
            var k = candidates[c].wordIdx;
            marks[k] = (marks[k] ? marks[k] + " " : "") + "[" + candidates[c].index + "]";
        }

        var parts = [];
        if (from > 0) parts.push("...");
        for (var i = from; i <= to; i++) {
            if (marks[i]) parts.push(marks[i]);
            if (i < spoken.length) parts.push(wordText(spoken[i]));
        }
        if (to < spoken.length) parts.push("...");
        return parts.join(" ");
    }

    // ─── Prompt ──────────────────────────────────────────────

    var SYSTEM_MSG = "Eres asistente de montaje de clases grabadas por intentos: el profesor se corta, " +
        "vuelve atrás y repite. Recibes lo que el CD escribió en los marcadores, la transcripción de los " +
        "dos lados del corte y varios puntos de corte posibles numerados como [1], [2], ... " +
        "Tu única tarea es elegir el número del punto donde el corte deja la clase con sentido: sin " +
        "decir dos veces lo mismo y sin ideas a medias. " +
        "Responde SIEMPRE únicamente con JSON válido, sin explicaciones fuera del JSON.";

    /**
     * Dónde va el corte cuando el CD no dejó nada que ubique el borde.
     *
     * @param {object} unit
     *   {kind, blockNum, blockCount, markerTime, candidates, current, hint,
     *    notes: [{label, text}]     — comentarios del CD tal como los escribió
     *    neighbour: {label, text}   — qué dice el bloque de al lado tras el corte}
     *
     * Los comentarios y el bloque vecino van literales para que el modelo lea la
     * intención del editor, no una frase que se le haya extraído. Las opciones siguen
     * siendo las pausas de la ventana: dejarle además los arranques de frase del bloque
     * entero se midió contra el modelo local y se iba lejos del borde. Quitar un intento
     * completo se decide en `buildRetakePrompt`, con sus condiciones.
     */
    function buildChoicePrompt(unit, words, opts) {
        var isIn = unit.kind === "IN";
        var marked = buildMarkedText(words, unit.candidates, opts);

        var list = [];
        var hasCue = false;
        for (var i = 0; i < unit.candidates.length; i++) {
            var c = unit.candidates[i];
            var tag = "[" + c.index + "] t=" + c.time.toFixed(1) + "s";
            if (c.gapSec < 900) tag += " (pausa " + c.gapSec.toFixed(2) + "s)";
            if (c.isCue) { tag += " ★ aquí " + (isIn ? "empieza" : "termina") + " la frase de la nota"; hasCue = true; }
            if (c.isCurrent) tag += " ← donde está ahora";
            list.push(tag);
        }

        var rules = isIn
            ? "El corte [n] elegido será el INICIO del bloque: todo lo anterior se ELIMINA.\n" +
              "- Elige el punto donde arranca la primera frase con sentido del bloque.\n" +
              "- Deja FUERA conteos (\"3, 2, 1\"), cues de producción (\"listo\", \"grabando\", \"acción\"), " +
              "carraspeos, arranques a medias y repeticiones de lo que ya se dijo en el bloque anterior.\n" +
              "- No dejes fuera palabras que hacen falta para entender la primera frase."
            : "El corte [n] elegido será el FINAL del bloque: todo lo posterior se ELIMINA.\n" +
              "- Elige el punto justo después de la última frase completa del bloque.\n" +
              "- Deja FUERA comandos al editor (\"pausa\", \"corte\", \"va de nuevo\"), errores, titubeos " +
              "y frases a medias que se repiten después.\n" +
              "- No cortes una frase por la mitad: si la frase sigue, elige un punto posterior.";

        // Lo que el bloque de al lado dice después del corte. Sin esto no se puede saber
        // si lo que queda aquí dentro es un intento que allí se rehace, y ese es
        // justamente el error que el editor ve como "dejó la repetición".
        var around = "";
        if (unit.neighbour && unit.neighbour.text) {
            around = unit.neighbour.label + ":\n\"" + unit.neighbour.text + "\"\n\n";
            rules += isIn
                ? "\n- Si este bloque empieza repitiendo algo que el bloque anterior ya dice, ábrelo " +
                  "DESPUÉS de esa repetición."
                : "\n- La clase no puede decir dos veces lo mismo: si el bloque siguiente vuelve a " +
                  "explicar algo que aquí ya se empieza a explicar, cierra ANTES de donde arranca ese " +
                  "intento —aunque sean VARIAS FRASES antes y aunque no use las mismas palabras.\n" +
                  "- Pero no cierres antes de algo que el bloque siguiente NO recupera: eso se perdería.";
        }

        // El comentario del CD, tal como lo escribió. Trae dos cosas que ninguna regla
        // sabe leer juntas: con qué abre o cierra el bloque y qué hacer con el borde
        // ("out antes de …", "revisar out"). Va literal para que el modelo lo interprete
        // con el transcript delante.
        var notes = "";
        if (unit.notes && unit.notes.length) {
            var lines = [];
            for (var n = 0; n < unit.notes.length; n++) {
                if (unit.notes[n].text) lines.push("- " + unit.notes[n].label + ": «" + unit.notes[n].text + "»");
            }
            if (lines.length) {
                notes = "LO QUE EL CD ESCRIBIÓ EN LOS MARCADORES:\n" + lines.join("\n") + "\n\n";
            }
        }

        var padFrames = Math.round(Number(opt(opts, "padFrames")) || 0);
        var padNote = padFrames > 0
            ? "Cada punto ya trae " + padFrames + " frames de aire hacia el silencio; " +
              "elige por el contenido, no por el tiempo exacto.\n"
            : "";

        // La nota que el CD escribió en el marcador dice con qué frase abre o
        // cierra el bloque. Es el dato más fiable que hay: manda sobre cualquier
        // impresión de "esto ya se dijo" — la clase repite frases a propósito, una
        // toma por intento, y la nota es la que distingue la buena.
        var cueNote = "";
        if (unit.cue) {
            cueNote = "NOTA DEL CD (lo que el bloque debe " + (isIn ? "decir al ARRANCAR" : "decir al CERRAR") +
                (unit.cuePartial ? ", recortada por el CD a media frase" : "") +
                "): \"" + unit.cue + "\"\n";
            if (unit.cuePartial) {
                cueNote += "Es solo el principio, así que ningún punto la trae marcada: busca dónde EMPIEZA " +
                    "una frase que continúe así y ábrelo ahí, aunque suene a transición — el CD la quiere " +
                    "DENTRO del bloque.\n";
            } else if (hasCue) {
                cueNote += "Los puntos con ★ son donde esa frase " + (isIn ? "empieza" : "termina") +
                    " en la transcripción. Si hay varios ★, la frase se grabó varias veces: " +
                    "elige la toma COMPLETA y mejor dicha (normalmente la última), no la que se corta a medias.\n" +
                    "La nota manda sobre la impresión de \"esto ya se dijo\": la clase repite frases " +
                    "porque se graba por intentos, y las palabras de la nota van DENTRO de este bloque.\n";
            } else {
                cueNote += "Ningún punto coincide con esa frase; elige el que más se le acerque.\n";
            }
        }

        var prompt = "BLOQUE " + unit.blockNum + " de " + unit.blockCount + " — marcador " + unit.kind + ".\n" +
            "Ahora está en t=" + unit.markerTime.toFixed(1) + "s" +
            (unit.current ? " (punto [" + unit.current + "])" : "") + ".\n\n" +
            notes +
            cueNote +
            (cueNote ? "\n" : "") +
            around +
            "TRANSCRIPCIÓN CON LOS PUNTOS DE CORTE POSIBLES:\n" + marked + "\n\n" +
            "PUNTOS:\n" + list.join("\n") + "\n\n" +
            rules + "\n" + padNote +
            (unit.hint ? "\nPista del detector automático: " + unit.hint + "\n" : "") +
            "\nSi el marcador ya está en el punto correcto" + (unit.current ? " ([" + unit.current + "])" : "") +
            ", responde ese mismo número.\n" +
            "Responde solo JSON:\n" +
            '{"choice": <número de la lista>, "reason": "<motivo breve en español>"}';

        return { systemMsg: SYSTEM_MSG, prompt: prompt };
    }

    // ─── Arranques de frase del bloque ───────────────────────

    var ENDS_SENTENCE = /[.?!…]["'”’)]?$/;

    /**
     * Los ARRANQUES DE FRASE del bloque, para ofrecerlos como puntos de corte.
     *
     * Un intento que el profesor abandona y vuelve a grabar empieza en una frase, no en
     * mitad de una: si el bloque siguiente rehace lo que aquí se empezó a explicar, el
     * cierre correcto está en uno de estos puntos, y suele quedar muy lejos del marcador
     * (varias frases antes), fuera de la ventana normal de candidatos.
     *
     * El punto de corte de cada uno es el final de la frase anterior, así que elegirlo
     * deja fuera esa frase y todo lo que venga detrás.
     *
     * @param {string} side "tail" (cola del bloque, para el OUT) | "head" (para el IN)
     * @returns {Array} [{time (donde cortaría), startTime, snippet, wordIdx}]
     */
    function sentenceStarts(words, fromTime, toTime, side, opts) {
        var spoken = spokenWords(words);
        var keep = opt(opts, "sentenceKeepSec");
        var reach = opt(opts, "sentenceReachSec");
        var lo = fromTime, hi = toTime;
        if (side === "head") hi = Math.min(toTime - keep, fromTime + reach);
        else lo = Math.max(fromTime + keep, toTime - reach);
        var out = [];

        for (var i = 1; i < spoken.length; i++) {
            var w = spoken[i], prev = spoken[i - 1];
            if (w.start < lo || w.start >= hi) continue;
            if (!ENDS_SENTENCE.test(wordText(prev).replace(/\s+$/, ""))) continue;
            out.push({
                startTime: round(w.start),
                // El IN abre en la palabra; el OUT cierra en la anterior.
                time: round(side === "head" ? w.start : prev.end),
                wordIdx: i,
                snippet: snippetFrom(spoken, i, opt(opts, "sentenceSnippetWords"))
            });
        }

        // Si hay más frases que sitio en la lista, se queda con las de al lado del corte:
        // es donde la toma se abandonó (cola) o donde el bloque arranca (cabeza).
        var max = opt(opts, "sentenceMax");
        if (out.length > max) out = side === "head" ? out.slice(0, max) : out.slice(out.length - max);
        for (var k = 0; k < out.length; k++) out[k].index = k + 1;
        return out;
    }

    // ─── ¿Sobra un intento entero? ───────────────────────────

    var RETAKE_SYSTEM_MSG = "Eres asistente de montaje de clases grabadas por intentos: el profesor " +
        "empieza a explicar algo, se corta, y vuelve a grabar la explicación desde el principio. Tu " +
        "única tarea es decir si el borde de un corte deja la misma explicación dos veces, y desde qué " +
        "frase sobra. Responde SIEMPRE únicamente con JSON válido, sin explicaciones fuera del JSON.";

    /**
     * La revisión del borde con el contexto completo: los comentarios del CD tal como
     * están escritos, lo que dice el bloque de al lado y las frases de este bloque como
     * opciones. La pregunta NO es dónde cortar —eso ya lo dice la nota del CD— sino si
     * dejar el corte ahí deja la clase diciendo dos veces lo mismo.
     *
     * Preguntar en abierto ("elige el mejor punto de estos 14") se midió contra el modelo
     * local y sale peor: movía bordes que la nota del CD ya tenía bien (1004.4 → 1008.9)
     * porque cualquier arranque de frase le parece un buen sitio. Con el "está bien" por
     * defecto solo se mueve cuando encuentra la explicación repetida.
     *
     * @param {object} unit {kind, blockNum, at, notes, neighbour, mine, candidates}
     */
    function buildRetakePrompt(unit, opts) {
        var isIn = unit.kind === "IN";
        var list = ["[0] " + (isIn
            ? "El bloque abre bien donde está: no repite nada del bloque anterior."
            : "El bloque cierra bien donde está: el bloque siguiente no rehace nada de esto.")];
        for (var i = 0; i < unit.candidates.length; i++) {
            list.push("[" + unit.candidates[i].index + "] \"" + unit.candidates[i].snippet + "\"");
        }

        var notes = "";
        if (unit.notes && unit.notes.length) {
            var lines = [];
            for (var n = 0; n < unit.notes.length; n++) {
                if (unit.notes[n].text) lines.push("- " + unit.notes[n].label + ": «" + unit.notes[n].text + "»");
            }
            if (lines.length) notes = "LO QUE EL CD ESCRIBIÓ EN LOS MARCADORES:\n" + lines.join("\n") + "\n\n";
        }

        var prompt = "BLOQUE " + unit.blockNum + " — el corte " + (isIn ? "abre" : "cierra") +
            " el bloque en t=" + unit.at.toFixed(1) + "s.\n\n" + notes +
            (unit.neighbour ? unit.neighbour.label + ":\n\"" + unit.neighbour.text + "\"\n\n" : "") +
            (unit.mine ? unit.mine.label + ":\n\"" + unit.mine.text + "\"\n\n" : "") +
            (isIn
                ? "FRASES CON LAS QUE ESTE BLOQUE PUEDE ABRIR:\n"
                : "FRASES DEL FINAL DE ESTE BLOQUE:\n") + list.join("\n") + "\n\n" +
            (isIn
                ? "Si este bloque empieza repitiendo la explicación que el bloque anterior ya da, hay que " +
                  "abrirlo más tarde: devuelve la PRIMERA frase que ya no repite.\n"
                : "Si el bloque siguiente vuelve a grabar una explicación que este bloque ya empezó a " +
                  "dar, hay que cerrar antes: devuelve la PRIMERA frase cuyo CONTENIDO el bloque " +
                  "siguiente vuelve a decir. Desde ahí se elimina todo.\n" +
                  "El intento abandonado no empieza donde se repiten las mismas palabras: empieza VARIAS " +
                  "FRASES ANTES, donde el profesor arrancó la explicación que después rehizo. Compara el " +
                  "CONTENIDO, no las palabras.\n") +
            "Si no hay nada repetido —el bloque de al lado habla de otra cosa o sigue avanzando el " +
            "tema— responde 0. Responder 0 es la respuesta normal.\n\n" +
            "Responde solo JSON:\n" +
            '{"choice": <número de la lista o 0>, "reason": "<motivo breve en español>"}';

        return { systemMsg: RETAKE_SYSTEM_MSG, prompt: prompt };
    }

    /**
     * @returns {{ok, move, time?, snippet?, reason?, detail}}
     */
    function resolveRetake(response, unit) {
        if (!response || response.error) {
            return { ok: false, move: false, detail: "sin respuesta del LLM" };
        }
        var choice = parseChoice(response);
        if (choice === null) return { ok: false, move: false, detail: "respuesta sin número" };
        var reason = response.reason ? String(response.reason) : "";
        if (choice === 0) {
            return { ok: true, move: false, reason: reason,
                detail: "el bloque de al lado no rehace nada de este borde" };
        }
        if (choice < 1 || choice > unit.candidates.length) {
            return { ok: false, move: false,
                detail: "frase [" + choice + "] fuera de la lista (1-" + unit.candidates.length + ")" };
        }
        var cand = unit.candidates[choice - 1];
        return {
            ok: true, move: true, time: cand.time, snippet: cand.snippet, reason: reason,
            detail: (unit.kind === "IN"
                ? "el bloque repetía hasta \"" + cand.snippet + "\": abre en t="
                : "el bloque siguiente rehace desde \"" + cand.snippet + "\": cierra en t=") +
                cand.time.toFixed(1) + "s"
        };
    }

    /** La frase que empieza en `from`, hasta su punto final o hasta `limit` palabras. */
    function snippetFrom(spoken, from, limit) {
        var parts = [];
        for (var i = from; i < spoken.length && parts.length < limit; i++) {
            parts.push(wordText(spoken[i]));
            if (ENDS_SENTENCE.test(wordText(spoken[i]).replace(/\s+$/, ""))) break;
        }
        return parts.join(" ");
    }

    /** Las primeras palabras del bloque siguiente: con qué vuelve a arrancar. */
    function headText(words, fromTime, toTime, limit) {
        var spoken = spokenWords(words), parts = [];
        for (var i = 0; i < spoken.length && parts.length < limit; i++) {
            if (spoken[i].start < fromTime) continue;
            if (toTime && spoken[i].start >= toTime) break;
            parts.push(wordText(spoken[i]));
        }
        return parts.join(" ");
    }

    /** Las últimas palabras del bloque anterior: con qué se queda antes del corte. */
    function tailText(words, fromTime, toTime, limit) {
        var spoken = spokenWords(words), parts = [];
        for (var i = 0; i < spoken.length; i++) {
            if (spoken[i].end <= fromTime) continue;
            if (spoken[i].end > toTime) break;
            parts.push(wordText(spoken[i]));
        }
        if (parts.length > limit) parts = parts.slice(parts.length - limit);
        return parts.join(" ");
    }

    // ─── Respuesta ───────────────────────────────────────────

    function parseChoice(response) {
        if (!response) return null;
        var raw = response.choice;
        if (raw === undefined || raw === null) raw = response.index;
        if (raw === undefined || raw === null) raw = response.punto;
        if (raw === undefined || raw === null) return null;
        if (typeof raw === "string") {
            var m = raw.match(/-?\d+/);
            if (!m) return null;
            raw = m[0];
        }
        var n = parseInt(raw, 10);
        return isNaN(n) ? null : n;
    }

    /**
     * Valida la elección del LLM contra la lista de candidatos.
     * @returns {{ok, move, time?, candidateIndex?, reason?, detail}}
     */
    function resolveChoice(response, unit) {
        if (!response || response.error) {
            return { ok: false, move: false, detail: "sin respuesta del LLM" };
        }
        var choice = parseChoice(response);
        if (choice === null) {
            return { ok: false, move: false, detail: "respuesta sin número de punto" };
        }
        if (choice < 1 || choice > unit.candidates.length) {
            return { ok: false, move: false, detail: "punto [" + choice + "] fuera de la lista (1-" + unit.candidates.length + ")" };
        }
        var reason = response.reason ? String(response.reason) : "";
        var cand = unit.candidates[choice - 1];

        // Aun confirmando el punto, se devuelve su tiempo: el marcador puede estar
        // pegado a la palabra y el punto trae el colchón de aire. Quien llama
        // decide si la diferencia amerita mover (MIN_CHANGE).
        if (unit.current && choice === unit.current) {
            return {
                ok: true,
                move: true,
                confirmed: true,
                time: cand.time,
                candidateIndex: choice,
                reason: reason,
                detail: "el LLM confirma el punto actual (t=" + cand.time.toFixed(1) + "s con colchón)"
            };
        }
        return {
            ok: true,
            move: true,
            confirmed: false,
            time: cand.time,
            candidateIndex: choice,
            reason: reason,
            detail: "elige [" + choice + "] t=" + cand.time.toFixed(1) + "s"
        };
    }

    var EPMarkerPrecision = {
        DEFAULTS: DEFAULTS,
        buildCandidates: buildCandidates,
        buildMarkedText: buildMarkedText,
        buildChoicePrompt: buildChoicePrompt,
        resolveChoice: resolveChoice,
        sentenceStarts: sentenceStarts,
        buildRetakePrompt: buildRetakePrompt,
        resolveRetake: resolveRetake,
        headText: headText,
        tailText: tailText,
        parseChoice: parseChoice,
        boundaryTime: boundaryTime,
        boundaryAt: boundaryAt,
        padSec: padSec
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = EPMarkerPrecision;
    }
    if (global) {
        global.EPMarkerPrecision = EPMarkerPrecision;
    }

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
