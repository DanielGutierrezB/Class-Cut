/**
 * marker-reviewer.js — Lógica del Revisor de Marcadores
 *
 * Módulo puro (testeable en Node, sin DOM/CEP): opera sobre marcadores de
 * secuencia ({name, comments, startSeconds, colorIndex}) y words[] del STT
 * ({text, start, end, type}).
 *
 * Responsabilidades:
 *   - parsePairs(markers, opts)        → pares IN/OUT (skip claqueta por nombre)
 *   - contextForTime(words, t, n)      → palabras alrededor de un tiempo
 *   - snippetAround(words, t, n)       → frase legible alrededor de un tiempo
 *   - detectLeadIns(words, pairs)      → conteos "3,2,1" al inicio de un bloque
 *   - clampToWordGap(words, t, mode)   → nunca cortar a mitad de palabra
 *   - buildFinalTranscript(words, blocks) → transcript de la clase resultante
 *   - buildCoherencePrompt(text)       → prompt del chequeo final de sentido
 *
 * La orquestación (evalScript, aiAnalyzer, UI) vive en ui-marker-reviewer.js.
 * Expone: window.EPMarkerReviewer / module.exports
 */
(function(global) {
    "use strict";

    var DEFAULTS = {
        skipClapperboard: true,
        inPreMin: 0.1,         // margen mínimo antes de la primera palabra del IN
        inPreMax: 0.4,         // margen máximo
        outPostMin: 0.1,       // margen mínimo después de la última palabra del OUT
        outPostMax: 0.4,       // margen máximo
        minChangeSeconds: 0.12, // por debajo de esto se considera "keep"
        phraseGapSeconds: 0.45, // silencio que separa una frase de la siguiente
        maxBandSeconds: 30      // por encima de esto la duración del IN no es una banda
    };

    function mergeOpts(opts) {
        var o = {};
        var k;
        for (k in DEFAULTS) {
            if (DEFAULTS.hasOwnProperty(k)) o[k] = DEFAULTS[k];
        }
        if (opts) {
            for (k in opts) {
                if (opts.hasOwnProperty(k)) o[k] = opts[k];
            }
        }
        return o;
    }

    // ─── Parseo de marcadores → pares IN/OUT ─────────────────

    function isOutMarker(marker) {
        var c = (marker.comments || "").trim();
        return c.indexOf("OUT:") === 0;
    }

    function isClapperboardMarker(marker) {
        var txt = ((marker.name || "") + " " + (marker.comments || "")).toLowerCase();
        return txt.indexOf("clapper") !== -1 || txt.indexOf("claqueta") !== -1;
    }

    /**
     * markers: [{name, comments, startSeconds, colorIndex}]
     * Devuelve { pairs, skipped, warnings, error }
     * pair = { inMarker, outMarker } (referencias a los marcadores originales)
     */
    function parsePairs(markers, opts) {
        opts = mergeOpts(opts);
        if (!markers || markers.length === 0) {
            return { pairs: [], skipped: [], warnings: [], error: "No se encontraron marcadores." };
        }

        var sorted = markers.slice(0).sort(function(a, b) { return a.startSeconds - b.startSeconds; });

        var working;
        var skipped = [];
        if (opts.skipClapperboard) {
            working = [];
            for (var c = 0; c < sorted.length; c++) {
                if (isClapperboardMarker(sorted[c])) skipped.push(sorted[c]);
                else working.push(sorted[c]);
            }
            if (skipped.length === 0 && sorted.length > 0) {
                skipped.push(sorted[0]);
                working = sorted.slice(1);
            }
        } else {
            working = sorted.slice(0);
        }

        if (working.length === 0) {
            return { pairs: [], skipped: skipped, warnings: [], error: "Solo se encontró el marcador de claqueta." };
        }

        var pairs = [];
        var warnings = [];
        var currentIn = null;

        for (var i = 0; i < working.length; i++) {
            var m = working[i];
            if (isOutMarker(m)) {
                if (currentIn !== null) {
                    pairs.push({ inMarker: currentIn, outMarker: m });
                    currentIn = null;
                } else {
                    warnings.push("OUT huérfano en " + m.startSeconds.toFixed(1) + "s (sin IN previo)");
                }
            } else {
                if (currentIn !== null) {
                    if (opts.skipClapperboard && pairs.length === 0) {
                        skipped.push(currentIn);
                    } else {
                        warnings.push("IN huérfano en " + currentIn.startSeconds.toFixed(1) + "s (seguido de otro IN)");
                    }
                }
                currentIn = m;
            }
        }
        if (currentIn !== null) {
            warnings.push("IN huérfano en " + currentIn.startSeconds.toFixed(1) + "s (sin OUT de cierre)");
        }

        if (pairs.length === 0) {
            return { pairs: [], skipped: skipped, warnings: warnings, error: "No se encontraron pares IN/OUT válidos." };
        }

        return { pairs: pairs, skipped: skipped, warnings: warnings, error: null };
    }

    // ─── Ventanas de audio a transcribir ────────────────────

    /**
     * Para ahorrar tiempo, en vez de transcribir toda la clase solo se
     * transcriben ventanas alrededor de cada bloque IN/OUT: [in - margin,
     * out + margin]. Ventanas que se solapan se fusionan. Cubre el contexto
     * del IN, del OUT y de las transiciones (el margen suele solapar bloques
     * cercanos). Devuelve [{start, end}] en segundos, ordenadas.
     */
    function computeAudioWindows(pairs, opts) {
        opts = mergeOpts(opts);
        var margin = typeof opts.windowMarginSec === "number" ? opts.windowMarginSec : 60;
        var wins = [];
        for (var i = 0; i < pairs.length; i++) {
            var s = Math.max(0, pairs[i].inMarker.startSeconds - margin);
            var e = pairs[i].outMarker.startSeconds + margin;
            if (e > s) wins.push({ start: s, end: e });
        }
        wins.sort(function(a, b) { return a.start - b.start; });
        var merged = [];
        for (var w = 0; w < wins.length; w++) {
            var last = merged[merged.length - 1];
            if (last && wins[w].start <= last.end) {
                if (wins[w].end > last.end) last.end = wins[w].end;
            } else {
                merged.push({ start: wins[w].start, end: wins[w].end });
            }
        }
        return merged;
    }

    /**
     * ¿Las ventanas cubren todas las fronteras relevantes de los pares?
     * Un transcript parcial guardado solo se reutiliza si cubre lo que se va
     * a validar ahora (con un pequeño colchón).
     */
    function windowsCoverPairs(windows, pairs, pad) {
        if (!windows || windows.length === 0) return false;
        pad = pad || 5;
        function covered(t) {
            for (var w = 0; w < windows.length; w++) {
                if (t >= windows[w].start - pad && t <= windows[w].end + pad) return true;
            }
            return false;
        }
        for (var i = 0; i < pairs.length; i++) {
            if (!covered(pairs[i].inMarker.startSeconds)) return false;
            if (!covered(pairs[i].outMarker.startSeconds)) return false;
        }
        return true;
    }

    // ─── Contexto de palabras ────────────────────────────────

    /**
     * Devuelve { before: [...], after: [...] } con hasta n palabras habladas
     * a cada lado de `time`. Cada entry: { text, start, end }.
     */
    function contextForTime(words, time, n) {
        var before = [];
        var after = [];
        if (!words) return { before: before, after: after };
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            if (w.type && w.type !== "word") continue;
            var mid = (w.start + w.end) / 2;
            if (mid < time) before.push(w);
            else after.push(w);
        }
        if (before.length > n) before = before.slice(before.length - n);
        if (after.length > n) after = after.slice(0, n);
        return { before: before, after: after };
    }

    /**
     * Frase legible (sin timestamps) de hasta n palabras antes/después de time.
     */
    function snippetAround(words, time, n) {
        var ctx = contextForTime(words, time, n);
        var beforeTxt = [];
        var afterTxt = [];
        var i;
        for (i = 0; i < ctx.before.length; i++) beforeTxt.push(ctx.before[i].text);
        for (i = 0; i < ctx.after.length; i++) afterTxt.push(ctx.after[i].text);
        return { before: beforeTxt.join(" "), after: afterTxt.join(" ") };
    }

    // ─── Clamp a gaps de palabra ─────────────────────────────

    /**
     * Ajusta un tiempo propuesto para que caiga en silencio, nunca a mitad
     * de palabra.
     *   mode "in":  el tiempo queda ANTES de la palabra que abre la frase
     *               (margen dentro del gap previo).
     *   mode "out": el tiempo queda DESPUÉS de la palabra que cierra la frase
     *               (margen dentro del gap siguiente).
     */
    function clampToWordGap(words, time, mode, opts) {
        opts = mergeOpts(opts);
        if (!words || words.length === 0) return time;

        var spoken = [];
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            if (w.type && w.type !== "word") continue;
            spoken.push(w);
        }
        if (spoken.length === 0) return time;

        // Palabra que contiene el tiempo propuesto (política conservadora:
        // una palabra a medias siempre se INCLUYE en el bloque — el IN salta
        // antes de ella y el OUT después de ella)
        var containing = -1;
        var ci;
        for (ci = 0; ci < spoken.length; ci++) {
            if (spoken[ci].start < time && spoken[ci].end > time) { containing = ci; break; }
        }

        if (mode === "in") {
            // Palabra objetivo: la que contiene el tiempo, o la primera cuyo
            // punto medio queda en o después de time
            var target = null;
            var prevW = null;
            if (containing !== -1) {
                target = spoken[containing];
                prevW = spoken[containing - 1] || null;
            } else {
                for (var a = 0; a < spoken.length; a++) {
                    if ((spoken[a].start + spoken[a].end) / 2 >= time) { target = spoken[a]; prevW = spoken[a - 1] || null; break; }
                }
            }
            if (!target) return time; // después de la última palabra: dejar
            var gapStart = prevW ? prevW.end : 0;
            var gap = Math.max(0, target.start - gapStart);
            var pre = Math.min(opts.inPreMax, Math.max(opts.inPreMin, gap / 2));
            var t = target.start - pre;
            if (prevW) t = Math.max(t, prevW.end + 0.02);
            return Math.max(0, Math.min(t, target.start));
        }

        // mode "out": palabra objetivo: la que contiene el tiempo, o la
        // última cuyo punto medio queda en o antes de time
        var targetO = null;
        var nextW = null;
        if (containing !== -1) {
            targetO = spoken[containing];
            nextW = spoken[containing + 1] || null;
        } else {
            for (var b = spoken.length - 1; b >= 0; b--) {
                if ((spoken[b].start + spoken[b].end) / 2 <= time) { targetO = spoken[b]; nextW = spoken[b + 1] || null; break; }
            }
        }
        if (!targetO) return time; // antes de la primera palabra: dejar
        var gapO = nextW ? Math.max(0, nextW.start - targetO.end) : Infinity;
        var post = gapO === Infinity
            ? opts.outPostMax
            : Math.min(opts.outPostMax, Math.max(opts.outPostMin, gapO / 2));
        var tO = targetO.end + post;
        if (nextW) tO = Math.min(tO, nextW.start - 0.02);
        return Math.max(tO, targetO.end);
    }

    // ─── La banda que el CD le da al marcador IN ─────────────
    //
    // El CD le pone ~10s de duración a cada IN (el OUT vive en un frame). Esa banda
    // es lo que el CD marcó como "por aquí abre el bloque", y hasta ahora se tiraba:
    // solo se leía `startSeconds`.
    //
    // Se usa en una sola dirección, la que arregla el defecto que se ve en la
    // timeline: el IN no se empuja MÁS ADELANTE del final de la banda. Empujarlo más
    // sería saltarse contenido que el CD marcó como la apertura, y es exactamente lo
    // que el editor reportaba como "el marcador inicia después de donde debería".
    // Hacia atrás no limita nada: mover el IN antes es lo que hace `take-start`
    // cuando el CD lo dejó a mitad de la toma.

    /**
     * La banda de un marcador, si su duración es creíble como tal.
     * @returns {object|null} {start, end, span}
     */
    function markerBand(marker, opts) {
        opts = mergeOpts(opts);
        if (!marker || marker.endSeconds == null) return null;
        var span = marker.endSeconds - marker.startSeconds;
        // Un marcador de un frame es un punto, no una banda; uno larguísimo es otra
        // cosa (un rango de la secuencia) y tampoco habla de dónde abre el bloque.
        if (!(span > 0.5) || span > opts.maxBandSeconds) return null;
        return { start: marker.startSeconds, end: marker.endSeconds, span: span };
    }

    /**
     * ¿El punto elegido se sale de la banda que el CD marcó? Es señal, no ley: se
     * escribe en el log para saber si la convención de los 10s se cumple.
     * @returns {string} "" | "late" | "early"
     */
    function bandVerdict(band, time) {
        if (!band) return "";
        if (time > band.end) return "late";
        if (time < band.start) return "early";
        return "";
    }

    // ─── Detector determinístico de conteos / lead-in ────────
    //
    // Independiente del LLM: si un bloque ARRANCA con un conteo ("3,2,1" /
    // "tres dos uno") o cues de producción ("listo", "grabando", "acción"),
    // propone avanzar el IN al final de ese conteo, donde empieza el contenido.
    // Resuelve el caso clásico aunque el modelo devuelva "keep".

    // "una" no entra: nadie cuenta "tres, dos, una", y como artículo abre frases
    // de contenido a todas horas ("Una pregunta de negocio sonaría...").
    var NUMBER_TOKENS = (function() {
        var m = {};
        var arr = ["0","1","2","3","4","5","6","7","8","9",
                   "cero","uno","dos","tres","cuatro","cinco","seis","siete","ocho","nueve","diez"];
        for (var i = 0; i < arr.length; i++) m[arr[i]] = true;
        return m;
    })();

    var CUE_TOKENS = (function() {
        var m = {};
        var arr = ["listo","dale","grabando","grabamos","accion","corre","corriendo",
                   "ya","aja","aja", "va", "vale"];
        for (var i = 0; i < arr.length; i++) m[arr[i]] = true;
        return m;
    })();

    // Con qué anuncia el profesor que vuelve a grabar. Vale sin conteo, pero solo si
    // es un anuncio suelto: lo que sigue tiene que abrir frase, o "Retomemos lo que
    // vimos la clase pasada" (que es clase) abriría el bloque en "lo".
    var RETAKE_TOKENS = (function() {
        var m = {};
        var arr = ["retomemos","retomamos","retomo","retoma","retomando",
                   "volvemos","repetimos","repito"];
        for (var i = 0; i < arr.length; i++) m[arr[i]] = true;
        return m;
    })();

    var ENDS_PHRASE = /(\.\.\.|…|[.!?])[")'\]»]*$/;

    // Normaliza un token: minúsculas, sin acentos ni puntuación.
    function normToken(text) {
        var t = String(text || "").toLowerCase();
        try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch(e) {}
        return t.replace(/[.,!?;:…"“”'’¿¡()\[\]—–\-]/g, "").replace(/\s+/g, "");
    }

    /** ¿La palabra en `idx` abre frase? (punto en la anterior o pausa en medio) */
    function opensPhrase(segWords, idx, opts) {
        if (idx <= 0 || idx >= segWords.length) return idx === 0;
        var prev = segWords[idx - 1].word, here = segWords[idx].word;
        if (ENDS_PHRASE.test(String(prev.text || "").replace(/\s+$/, ""))) return true;
        return (here.start - prev.end) >= opts.phraseGapSeconds;
    }

    // Palabras habladas (type "word") cuyo punto medio cae en [start, end].
    function wordsInRange(words, start, end) {
        var out = [];
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            if (w.type && w.type !== "word") continue;
            var mid = (w.start + w.end) / 2;
            if (mid >= start - 0.01 && mid <= end + 0.01) out.push({ word: w, index: i });
        }
        return out;
    }

    /**
     * Devuelve proposals de IN para bloques que empiezan con un conteo:
     * {kind:"IN", pairIdx, marker, originalTime, newTime, reason,
     * repeatedPhrase:"", snippet}.
     */
    function detectLeadIns(words, pairs, opts) {
        opts = mergeOpts(opts);
        var proposals = [];
        if (!words || !pairs) return proposals;

        for (var p = 0; p < pairs.length; p++) {
            var inT = pairs[p].inMarker.startSeconds;
            var outT = pairs[p].outMarker.startSeconds;
            var segWords = wordsInRange(words, inT, outT);
            if (segWords.length < 4) continue;

            // Run inicial de tokens de conteo/cue. Un número suelto no basta: hace
            // falta un conteo de verdad (dos números) o un número con un cue al
            // lado, o "Uno de los problemas..." se leería como "3, 2, 1".
            var runLen = 0;
            var numbers = 0;
            var cues = 0;
            var retakes = 0;
            for (var i = 0; i < segWords.length; i++) {
                var tk = normToken(segWords[i].word.text);
                if (tk === "") { runLen++; continue; } // puntuación: parte del run
                if (NUMBER_TOKENS[tk]) { numbers++; runLen++; }
                else if (CUE_TOKENS[tk]) { cues++; runLen++; }
                else if (RETAKE_TOKENS[tk]) { retakes++; runLen++; }
                else break;
            }
            if (runLen === 0) continue;
            var counted = numbers >= 2 || (numbers >= 1 && cues >= 1);
            if (!counted && !(retakes >= 1 && opensPhrase(segWords, runLen, opts))) continue;
            if (runLen >= segWords.length - 2) continue; // casi todo es conteo: no fiable

            var firstReal = segWords[runLen].word;
            var clamped = clampToWordGap(words, firstReal.start, "in", opts);
            if (clamped - inT < opts.minChangeSeconds) continue; // ya está donde debe

            proposals.push({
                kind: "IN",
                pairIdx: p,
                marker: pairs[p].inMarker,
                originalTime: inT,
                newTime: clamped,
                llmTime: firstReal.start,
                reason: "Conteo, arranque de producción o anuncio de retoma al inicio — " +
                    "el bloque empieza en la primera frase real",
                repeatedPhrase: "",
                deterministic: true,
                snippet: snippetAround(words, clamped, 6)
            });
        }
        return proposals;
    }

    // ─── Transcript final ────────────────────────────────────

    function _fmtTime(t) {
        var s = Math.max(0, Math.round(t));
        var m = Math.floor(s / 60);
        var sec = s % 60;
        return m + ":" + (sec < 10 ? "0" : "") + sec;
    }

    /**
     * blocks: [{inTime, outTime}] ya ajustados y ordenados.
     * Devuelve { text, blockTexts: [], wordCount } — el transcript de la
     * clase como quedaría después de cortar.
     */
    function buildFinalTranscript(words, blocks) {
        var blockTexts = [];
        var wordCount = 0;
        var spoken = [];
        var i;
        for (i = 0; i < (words || []).length; i++) {
            var w = words[i];
            if (w.type && w.type !== "word") continue;
            spoken.push(w);
        }
        for (var b = 0; b < blocks.length; b++) {
            var blk = blocks[b];
            var parts = [];
            for (i = 0; i < spoken.length; i++) {
                var mid = (spoken[i].start + spoken[i].end) / 2;
                if (mid >= blk.inTime && mid <= blk.outTime) {
                    parts.push(spoken[i].text);
                }
            }
            wordCount += parts.length;
            blockTexts.push({
                index: b + 1,
                inTime: blk.inTime,
                outTime: blk.outTime,
                text: parts.join(" ")
            });
        }

        var lines = [];
        for (var t = 0; t < blockTexts.length; t++) {
            lines.push("[Bloque " + blockTexts[t].index + " · " + _fmtTime(blockTexts[t].inTime) +
                " → " + _fmtTime(blockTexts[t].outTime) + "]");
            lines.push(blockTexts[t].text);
            lines.push("");
        }
        return { text: lines.join("\n").replace(/\n+$/, "\n"), blockTexts: blockTexts, wordCount: wordCount };
    }

    /**
     * Prompt para el chequeo final de coherencia del transcript resultante.
     */
    function buildCoherencePrompt(finalText) {
        return {
            systemMsg: "Eres un revisor editorial de clases educativas en video. Responde ÚNICAMENTE con JSON válido.",
            prompt: "Este es el transcript de una clase DESPUÉS de aplicar los cortes de edición " +
                "(cada bloque es un segmento que se conserva, en orden):\n\n" + finalText + "\n\n" +
                "Evalúa si la clase se cuenta con sentido:\n" +
                "1. ¿La narrativa fluye entre bloques (el final de un bloque conecta con el inicio del siguiente)?\n" +
                "2. ¿Hay frases cortadas a la mitad al inicio o final de algún bloque?\n" +
                "3. ¿Hay contenido repetido entre bloques consecutivos?\n" +
                "4. ¿Falta algo evidente (saltos bruscos de tema)?\n\n" +
                "Responde JSON:\n" +
                '{"coherent": true|false, "score": <1-10>, "issues": [{"block": <número o 0 si es general>, ' +
                '"type": "corte-frase"|"repeticion"|"salto-tema"|"otro", "detail": "<breve, en español>"}], ' +
                '"summary": "<2-3 frases en español sobre cómo queda contada la clase>"}'
        };
    }

    // Cómo suena en el detalle del revisor que el problema está en la apertura o en el
    // cierre. Es la única pista de qué borde arreglar cuando dice "frase cortada".
    var SAYS_HEAD = /\bin\b|inicio|empieza|arranca|abre|apertura|principio|comienza/i;
    var SAYS_TAIL = /\bout\b|final|termina|acaba|cierra|cierre|corta al final/i;
    // Cuando el revisor dice que un bloque repite, hay que saber a qué lado: "el bloque 5
    // repite lo YA dicho ANTES" señala el bloque 5 como la segunda vez, y entonces lo que
    // sobra es la cola del bloque 4. Sin esto se arreglaba el cierre equivocado.
    var SAYS_EARLIER = /anterior|antes|previo|ya (se )?(dicho|dijo|dio|dado|dada|menciona|mencionad|vist|explicad|habl)|anteriormente|arriba/i;

    /**
     * A qué bordes hay que volver según lo que dijo el revisor de coherencia.
     *
     * El revisor lee la clase ya cortada y habla de BLOQUES ("el bloque 4 repite lo que
     * dice el 5"); quien reajusta trabaja con BORDES:
     *
     *   · `repeticion` → un CIERRE, el del bloque que habló primero: lo que sobra es su
     *     cola, porque la toma buena es la segunda. Si el revisor dice que el bloque
     *     citado repite algo *anterior*, el cierre a arreglar es el del bloque de antes.
     *   · `corte-frase` → el borde que el detalle señale; si no lo dice, los dos.
     *
     * Los dos piden PRUEBA del transcript (`proof`), y no por desconfianza abstracta: el
     * modelo local cita mal el número de bloque. Leyendo cinco veces la clase 15 con la
     * repetición dentro, señaló el cierre correcto una vez, el de al lado tres y nada una.
     * Y lo que afirma se puede medir —que un corte parta una frase, que dos bloques digan
     * las mismas palabras—, así que se mide. Lo que no cuadra se queda en el log: un
     * corte de más en la clase cuesta más que un aviso que lee el editor.
     *
     * Lo que NO manda a ningún borde, medido sobre las clases 14 y 15 leídas con los
     * cortes ya buenos:
     *
     *   · `salto-tema`. Sale en 2 de 4 observaciones y siempre es lo mismo: entre dos
     *     tomas falta material que nunca se grabó ("salta de la teoría a la práctica sin
     *     transición"). Mover un marcador no añade clase; lo único que haría es estropear
     *     un borde que estaba bien.
     *   · `otro` y los generales (`block: 0`): "falta una introducción" no es un corte.
     *
     * @param {Array} issues [{block, type, detail}] tal como responde el revisor
     * @param {number} blockCount cuántos bloques tiene la clase
     * @param {object} [proof] lo que el transcript sí sostiene:
     *   `{cut: {"IN:3": true}, repeat: {"OUT:3": true}}`
     * @returns {Array} [{pairIdx, kind, type, detail}] sin repetidos
     */
    function coherenceTargets(issues, blockCount, proof) {
        var out = [], seen = {};
        var cut = (proof && proof.cut) || {};
        var repeat = (proof && proof.repeat) || {};

        function add(pairIdx, kind, issue, evidence) {
            if (pairIdx < 0 || pairIdx >= blockCount) return;
            var key = kind + ":" + pairIdx;
            if (seen[key] || !evidence[key]) return;
            seen[key] = true;
            out.push({ pairIdx: pairIdx, kind: kind, type: issue.type || "otro",
                detail: String(issue.detail || "") });
        }

        for (var i = 0; i < (issues || []).length; i++) {
            var issue = issues[i] || {};
            var num = Number(issue.block);
            if (!(num >= 1)) continue;          // 0 o basura: es un comentario general
            var idx = num - 1;
            var type = String(issue.type || "");
            var detail = String(issue.detail || "");

            if (type === "repeticion") {
                add(SAYS_EARLIER.test(detail) ? idx - 1 : idx, "OUT", issue, repeat);
                continue;
            }
            if (type === "corte-frase") {
                var head = SAYS_HEAD.test(detail), tail = SAYS_TAIL.test(detail);
                if (head || !tail) add(idx, "IN", issue, cut);
                if (tail || !head) add(idx, "OUT", issue, cut);
            }
        }
        return out;
    }

    var EPMarkerReviewer = {
        parsePairs: parsePairs,
        coherenceTargets: coherenceTargets,
        computeAudioWindows: computeAudioWindows,
        windowsCoverPairs: windowsCoverPairs,
        detectLeadIns: detectLeadIns,
        markerBand: markerBand,
        bandVerdict: bandVerdict,
        contextForTime: contextForTime,
        snippetAround: snippetAround,
        clampToWordGap: clampToWordGap,
        buildFinalTranscript: buildFinalTranscript,
        buildCoherencePrompt: buildCoherencePrompt,
        isOutMarker: isOutMarker,
        isClapperboardMarker: isClapperboardMarker
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = EPMarkerReviewer;
    }
    if (global) {
        global.EPMarkerReviewer = EPMarkerReviewer;
    }

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
