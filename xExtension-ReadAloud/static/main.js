(() => {
    'use strict';

    // ===== CONFIG ============================================================
    // Config comes from the FreshRSS extension settings, injected by
    // extension.php as query params on this script's URL (Minz_View has no
    // inline-<script> API). Falls back to defaults if the script is loaded
    // without those params.
    //
    //   ssml  -> SSML markup (emphasis / breaks / prosody). Apple voices on
    //            Safari/macOS honour it; Google voices read the tags out loud.
    //   langs -> comma-separated BCP-47 tags (es-es,en-gb). Only voices in
    //            those languages are listed. Empty = all voices.
    const CONFIG = (() => {
        const defaults = { ssml: false, languages: [] };
        try {
            const el =
                document.getElementById('read-aloud-js') ||
                document.currentScript;
            if (!el || !el.src) return defaults;
            const qs = new URL(el.src, location.href).searchParams;
            const languages = (qs.get('langs') || '')
                .split(',')
                .map(s => s.trim().toLowerCase())
                .filter(Boolean);
            return { ssml: qs.get('ssml') === '1', languages };
        } catch (e) {
            return defaults;
        }
    })();

    const SSML = CONFIG.ssml;
    // =========================================================================

    if (!('speechSynthesis' in window)) {
        console.warn('Speech synthesis not supported');
        return;
    }

    const synth = window.speechSynthesis;

    let voices = [];

    const STORAGE_VOICE = 'freshrss_tts_voice';
    const STORAGE_RATE = 'freshrss_tts_rate';

    // ----- voices -----------------------------------------------------------

    function loadVoices() {
        voices = synth.getVoices();
    }

    // A voice passes the language filter when its lang exactly matches a
    // configured tag (es-ES) or is a variant of a bare one (es -> es-*).
    // Empty filter shows everything.
    function voiceAllowed(voice) {
        const langs = CONFIG.languages;
        if (!langs.length) return true;
        const vl = (voice.lang || '').toLowerCase().replace('_', '-');
        return langs.some(l => vl === l || vl.startsWith(l + '-'));
    }

    loadVoices();

    // Voices load async on Chrome/Android; refresh when ready.
    synth.onvoiceschanged = () => {
        loadVoices();
        refreshVoiceDropdowns();
    };

    function getSelectedVoice() {
        return localStorage.getItem(STORAGE_VOICE) || '';
    }

    function setSelectedVoice(name) {
        localStorage.setItem(STORAGE_VOICE, name);
    }

    function getSelectedRate() {
        const r = parseFloat(localStorage.getItem(STORAGE_RATE) || '1');
        return isNaN(r) ? 1 : r;
    }

    function setSelectedRate(rate) {
        localStorage.setItem(STORAGE_RATE, rate);
    }

    function fillVoiceOptions(select) {
        const wanted = select.value || getSelectedVoice();

        select.innerHTML = '';

        const list = voices.filter(voiceAllowed);

        if (!list.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Default voice';
            select.appendChild(opt);
            return;
        }

        list.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.name;
            option.textContent = `${voice.name} (${voice.lang})`;
            select.appendChild(option);
        });

        // Restore selection if still available (and not filtered out).
        if (wanted && list.some(v => v.name === wanted)) {
            select.value = wanted;
        }
    }

    function refreshVoiceDropdowns() {
        document
            .querySelectorAll('.read-aloud-voice')
            .forEach(fillVoiceOptions);
    }

    // ----- text extraction --------------------------------------------------

    function extractText(article) {
        // Only the article body. Query each in priority order — a combined
        // selector would return the first match in *document* order, which
        // is the wrapping .content (header + title + tags).
        const textNode =
            article.querySelector('.text') ||
            article.querySelector('.flux_content');

        if (!textNode) {
            return '';
        }

        const clone = textNode.cloneNode(true);

        clone
            .querySelectorAll(
                'button, script, style, nav, .read-aloud-controls, .oai-summary-wrap'
            )
            .forEach(el => el.remove());

        // Keep link text, drop the link.
        clone.querySelectorAll('a').forEach(a => {
            a.replaceWith(document.createTextNode(a.textContent));
        });

        return clone.innerText.replace(/\s+/g, ' ').trim();
    }

    // Split into small chunks so Chrome (desktop + Android) does not cut
    // off long utterances at the ~15s / ~200 char limit.
    function splitIntoChunks(text, maxLen = 160) {
        const pieces = text.match(/[^.!?\n]+[.!?]*\s*/g) || [text];
        const chunks = [];
        let buf = '';

        const pushBuf = () => {
            const t = buf.trim();
            if (t) chunks.push(t);
            buf = '';
        };

        for (let piece of pieces) {
            // A single sentence longer than maxLen: break it on words.
            if (piece.length > maxLen) {
                pushBuf();
                let line = '';
                piece.split(/\s+/).forEach(word => {
                    if ((line + ' ' + word).trim().length > maxLen && line) {
                        chunks.push(line.trim());
                        line = '';
                    }
                    line += (line ? ' ' : '') + word;
                });
                if (line.trim()) chunks.push(line.trim());
                continue;
            }

            if ((buf + piece).length > maxLen && buf) {
                pushBuf();
            }
            buf += piece;
        }
        pushBuf();

        return chunks;
    }

    // ----- SSML --------------------------------------------------------------
    // Web Speech API: utterance.text may be a well-formed SSML document; engines
    // without SSML support strip the tags and read the text (W3C spec). Toggle
    // via the SSML flag at the top of this file.

    // Inline HTML tags -> emphasis level.
    const EMPH = {
        EM: 'moderate', I: 'moderate', CITE: 'moderate',
        STRONG: 'strong', B: 'strong', MARK: 'strong'
    };

    // Block tags: a paragraph break (<break>) is inserted after them.
    const BLOCK = new Set([
        'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
        'TABLE', 'TR', 'FIGURE', 'FIGCAPTION', 'PRE'
    ]);

    function escapeXml(s) {
        return s.replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // HTML serialises self-closing SSML voids as <break ...></break>;
    // rewrite them back to <break .../> which every engine accepts.
    function normBreak(s) {
        return s.replace(/<break([^>]*?)>\s*<\/break>/gi, '<break$1/>');
    }

    // Inline subtree -> inline SSML string (no sentence splitting inside).
    function inlineSSML(node) {
        let out = '';
        node.childNodes.forEach(n => {
            if (n.nodeType === 3) {
                out += escapeXml(n.textContent.replace(/\s+/g, ' '));
            } else if (n.nodeType === 1) {
                if (n.hasAttribute('data-ssml')) { out += n.innerHTML; return; }
                const inner = inlineSSML(n);
                if (!inner.trim()) return;
                const lvl = EMPH[n.tagName];
                out += lvl
                    ? `<emphasis level="${lvl}">${inner}</emphasis>`
                    : inner;
            }
        });
        return out;
    }

    // Walk the article DOM into a flat list of atomic SSML units: each is a
    // <s>…</s> sentence (inline tags balanced) or a <break/>. Chunking groups
    // whole units, so a tag is never split across utterances and a cut never
    // lands mid-sentence.
    function extractUnits(article) {
        const textNode =
            article.querySelector('.text') ||
            article.querySelector('.flux_content');
        if (!textNode) return [];

        const clone = textNode.cloneNode(true);
        clone
            .querySelectorAll(
                'button, script, style, nav, .read-aloud-controls, .oai-summary-wrap'
            )
            .forEach(el => el.remove());
        clone.querySelectorAll('a').forEach(a => {
            a.replaceWith(document.createTextNode(a.textContent));
        });

        const units = [];
        let sent = '';

        const flush = () => {
            const t = sent.trim();
            if (t) units.push(`<s>${t}</s>`);
            sent = '';
        };
        const brk = ms => { flush(); units.push(`<break time="${ms}ms"/>`); };

        function pushText(text) {
            text = text.replace(/\s+/g, ' ');
            const re = /[^.!?]*[.!?]+|[^.!?]+$/g;
            let m;
            while ((m = re.exec(text))) {
                const seg = m[0];
                if (!seg) break;
                sent += escapeXml(seg);
                // Flush on a sentence terminator, but not after a lone letter or
                // digit (abbrevs / decimals like "art." "7." "3.5").
                if (/[.!?]["')\]]*\s*$/.test(seg) &&
                    !/(\b[a-záéíóúñ]|\d)[.!?]["')\]]*\s*$/i.test(seg)) {
                    flush();
                }
            }
        }

        function walk(node) {
            node.childNodes.forEach(n => {
                if (n.nodeType === 3) { pushText(n.textContent); return; }
                if (n.nodeType !== 1) return;

                // Raw SSML passthrough: emit each child as its own unit.
                if (n.hasAttribute('data-ssml')) {
                    flush();
                    n.childNodes.forEach(c => {
                        if (c.nodeType === 3) {
                            const t = c.textContent.trim();
                            if (t) units.push(`<s>${escapeXml(t)}</s>`);
                        } else if (c.nodeType === 1) {
                            const h = c.outerHTML.trim();
                            if (h) units.push(h);
                        }
                    });
                    return;
                }

                const tag = n.tagName;
                if (tag === 'BR') { brk(300); return; }
                if (EMPH[tag]) {
                    const inner = inlineSSML(n);
                    if (inner.trim()) {
                        sent += `<emphasis level="${EMPH[tag]}">${inner}</emphasis>`;
                    }
                    return;
                }
                if (BLOCK.has(tag)) { walk(n); brk(500); return; }
                walk(n); // other inline (span, sup, sub, abbr): stay in sentence
            });
        }

        walk(clone);
        flush();
        return units.map(normBreak);
    }

    // Visible length (tags don't count toward the chunk budget).
    function visLen(u) { return u.replace(/<[^>]+>/g, '').length; }

    // A tag-free <s> longer than maxLen is split on word boundaries.
    function splitLongUnit(u, maxLen) {
        const m = u.match(/^<s>([\s\S]*)<\/s>$/);
        if (!m || /</.test(m[1])) return [u];
        const out = [];
        let line = '';
        m[1].split(/\s+/).forEach(w => {
            if ((line + ' ' + w).trim().length > maxLen && line) {
                out.push(`<s>${line.trim()}</s>`);
                line = '';
            }
            line += (line ? ' ' : '') + w;
        });
        if (line.trim()) out.push(`<s>${line.trim()}</s>`);
        return out;
    }

    function chunkUnits(units, maxLen) {
        const chunks = [];
        let buf = '';
        let len = 0;
        const push = () => { if (buf) { chunks.push(buf); buf = ''; len = 0; } };

        for (const u of units) {
            const l = visLen(u);
            if (len && len + l > maxLen) push();
            if (l > maxLen && !buf) {
                const parts = splitLongUnit(u, maxLen);
                if (parts.length > 1) { parts.forEach(p => chunks.push(p)); continue; }
            }
            buf += u;
            len += l;
        }
        push();
        return chunks;
    }

    function buildSpeak(body, lang) {
        return `<speak version="1.1" xml:lang="${lang}">${body}</speak>`;
    }

    // ----- player (single global engine) ------------------------------------

    const player = {
        generation: 0,   // bumps to invalidate stale utterance callbacks
        chunks: [],
        index: 0,
        controls: null,  // active controls object
        isPlaying: false,
        isPaused: false,
        isSSML: false    // chunks are SSML documents needing <speak> wrapping
    };

    function setUI(controls, state) {
        if (!controls) return;
        controls.state = state;

        const t = controls.toggle;
        if (state === 'playing') {
            t.textContent = '⏸';
            t.title = 'Pause';
            t.classList.add('is-active');
        } else if (state === 'paused') {
            t.textContent = '▶';
            t.title = 'Resume';
            t.classList.add('is-active');
        } else {
            t.textContent = '▶';
            t.title = 'Read aloud';
            t.classList.remove('is-active');
        }
        controls.stop.disabled = state === 'idle';
        controls.wrapper.classList.toggle('is-active', state !== 'idle');
    }

    function configureUtterance(u, controls) {
        const name = controls.voiceSelect.value;
        const v = voices.find(x => x.name === name);
        if (v) {
            u.voice = v;
            u.lang = v.lang;
        }
        let rate = parseFloat(controls.speedInput.value);
        if (isNaN(rate)) rate = 1;
        u.rate = Math.min(2, Math.max(0.5, rate));
        u.pitch = 1;
        u.volume = 1;
    }

    function speakNext(gen) {
        if (gen !== player.generation) return;

        if (player.index >= player.chunks.length) {
            finish(gen);
            return;
        }

        let payload = player.chunks[player.index];
        if (player.isSSML) {
            const v = voices.find(
                x => x.name === player.controls.voiceSelect.value
            );
            payload = buildSpeak(payload, (v && v.lang) || 'en-US');
        }

        const u = new SpeechSynthesisUtterance(payload);
        configureUtterance(u, player.controls);

        u.onend = () => {
            if (gen !== player.generation) return;
            player.index++;
            speakNext(gen);
        };

        u.onerror = e => {
            if (gen !== player.generation) return;
            // Cancel/interrupt fire on stop & pause; ignore those.
            if (e.error === 'interrupted' || e.error === 'canceled') return;
            finish(gen);
        };

        synth.speak(u);
    }

    function start(article, controls) {
        // Tear down whatever was running.
        resetState();
        synth.cancel();

        let chunks = null;
        let isSSML = false;
        if (SSML) {
            const units = extractUnits(article);
            if (units.length) { chunks = chunkUnits(units, 160); isSSML = true; }
        }
        if (!chunks || !chunks.length) {
            const text = extractText(article);
            if (!text) return;
            chunks = splitIntoChunks(text);
            isSSML = false;
        }
        if (!chunks.length) return;

        player.generation++;
        const gen = player.generation;
        player.chunks = chunks;
        player.isSSML = isSSML;
        player.index = 0;
        player.controls = controls;
        player.isPlaying = true;
        player.isPaused = false;

        setUI(controls, 'playing');

        // Chrome/Android can drop a speak() issued immediately after
        // cancel(); defer one tick.
        setTimeout(() => speakNext(gen), 0);
    }

    // Pause via cancel + restart-from-current-chunk. Native pause()/resume()
    // is unreliable on Android, cancel() is universal.
    function pause() {
        if (!player.isPlaying || player.isPaused) return;
        player.isPaused = true;
        player.generation++; // invalidate the in-flight chunk callbacks
        synth.cancel();
        setUI(player.controls, 'paused');
    }

    function resume() {
        if (!player.isPlaying || !player.isPaused) return;
        player.isPaused = false;
        player.generation++;
        const gen = player.generation;
        setUI(player.controls, 'playing');
        setTimeout(() => speakNext(gen), 0);
    }

    function finish(gen) {
        if (gen !== undefined && gen !== player.generation) return;
        const c = player.controls;
        resetState();
        if (c) setUI(c, 'idle');
    }

    function stopPlayback() {
        const c = player.controls;
        player.generation++;
        synth.cancel();
        resetState();
        if (c) setUI(c, 'idle');
    }

    function resetState() {
        player.chunks = [];
        player.index = 0;
        player.controls = null;
        player.isPlaying = false;
        player.isPaused = false;
    }

    function onToggle(article, controls) {
        if (player.controls === controls && player.isPlaying) {
            if (player.isPaused) {
                resume();
            } else {
                pause();
            }
            return;
        }
        start(article, controls);
    }

    // ----- UI construction --------------------------------------------------

    function createControls(article) {
        if (article.querySelector('.read-aloud-controls')) {
            return;
        }

        const header = article.querySelector('header') || article;

        const wrapper = document.createElement('div');
        wrapper.className = 'read-aloud-controls';

        // PLAY / PAUSE TOGGLE
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'read-aloud-btn read-aloud-toggle';
        toggle.textContent = '▶';
        toggle.title = 'Read aloud';

        // STOP
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'read-aloud-btn read-aloud-stop';
        stop.textContent = '⏹';
        stop.title = 'Stop';
        stop.disabled = true;

        // VOICE SELECT
        const voiceSelect = document.createElement('select');
        voiceSelect.className = 'read-aloud-voice';
        voiceSelect.title = 'Voice';
        fillVoiceOptions(voiceSelect);
        voiceSelect.value = getSelectedVoice();
        voiceSelect.addEventListener('change', () => {
            setSelectedVoice(voiceSelect.value);
        });

        // SPEED
        const speedInput = document.createElement('select');
        speedInput.className = 'read-aloud-speed';
        speedInput.title = 'Speed';
        [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach(r => {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = `${r}x`;
            speedInput.appendChild(opt);
        });
        speedInput.value = getSelectedRate();

        speedInput.addEventListener('change', () => {
            setSelectedRate(speedInput.value);
        });

        const controls = {
            wrapper,
            toggle,
            stop,
            voiceSelect,
            speedInput,
            state: 'idle'
        };

        const swallow = e => {
            e.preventDefault();
            e.stopPropagation();
        };

        toggle.addEventListener('click', e => {
            swallow(e);
            onToggle(article, controls);
        });

        stop.addEventListener('click', e => {
            swallow(e);
            if (player.controls === controls) stopPlayback();
        });

        wrapper.appendChild(toggle);
        wrapper.appendChild(stop);
        wrapper.appendChild(voiceSelect);
        wrapper.appendChild(speedInput);

        header.appendChild(wrapper);
    }

    function init() {
        document
            .querySelectorAll('article')
            .forEach(createControls);
    }

    init();

    const observer = new MutationObserver(() => init());
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('beforeunload', () => synth.cancel());
    // Stop audio if the article view is navigated away on mobile.
    window.addEventListener('pagehide', () => synth.cancel());
})();
