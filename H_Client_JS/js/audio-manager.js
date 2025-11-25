(function (global) {
    "use strict";

    class AudioManager {
        constructor(options = {}) {
            const {
                basePath = './dat/wav/kiri/',
                fileCount = 100,
                extension = '.wav',
                onPlayAck = null,
            } = options;
            this.basePath = basePath;
            this.count = fileCount;
            this.ext = extension;
            this.sendPlayAck = typeof onPlayAck === 'function' ? onPlayAck : () => { };
            this.audios = new Array(this.count).fill(null);
            this.queue = [];
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.waitingForServer = false;
            this.currentCardPos = null;
            this._preloadAll();
        }

        setAckCallback(cb) {
            this.sendPlayAck = typeof cb === 'function' ? cb : () => { };
        }

        _preloadAll() {
            for (let i = 0; i < this.count; i++) {
                const name = 'kiri' + String(i).padStart(2, '0') + this.ext;
                const audio = new Audio(this.basePath + name);
                audio.preload = 'auto';
                audio.addEventListener('error', (e) => console.warn('audio load error', name, e));
                this.audios[i] = audio;
            }
        }

        startSequence(cardLetters, owners) {
            this.stop();
            const items = [];
            const tableLetters = Array.isArray(cardLetters) ? cardLetters.slice(0, 10) : [];
            const presentSet = new Set(tableLetters.map((x) => x | 0));
            for (let i = 0; i < 10; i++) {
                if (!owners || !owners[i]) {
                    const letter = typeof tableLetters[i] !== 'undefined' ? (tableLetters[i] | 0) : 0;
                    items.push({ cardPos: i, letter: Math.max(0, Math.min(99, letter)) });
                }
            }
            const pool = [];
            for (let v = 0; v < 100; v++) {
                if (!presentSet.has(v)) pool.push(v);
            }
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            const extraCount = Math.min(9, pool.length);
            for (let k = 0; k < extraCount; k++) {
                items.push({ cardPos: null, letter: pool[k] });
            }
            for (let i = items.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [items[i], items[j]] = [items[j], items[i]];
            }
            this.queue = items;
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.waitingForServer = false;
            this.currentCardPos = null;
            if (this.queue.length > 0) this._playCurrent();
        }

        startSequenceFromServer(seq, startIndex = 0) {
            if (!Array.isArray(seq)) return;
            this.stop();
            this.queue = seq.map((item) => ({
                cardPos: typeof item.cardPos === 'number' ? item.cardPos : null,
                letter: item.letter | 0,
            }));
            const requestedIdx = Number(startIndex) || 0;
            const clampedIdx = Math.max(0, Math.min(this.queue.length - 1, requestedIdx));
            if (this.queue.length === 0) {
                this.pointer = 0;
                return;
            }
            if (requestedIdx >= this.queue.length) {
                // Already reached or passed the end; keep queue but do not restart playback.
                this.pointer = this.queue.length;
                this.playing = false;
                this.waitingForTake = false;
                this.waitingForServer = false;
                this.currentCardPos = null;
                return;
            }
            this.pointer = clampedIdx;
            this.playing = false;
            this.waitingForTake = false;
            this.waitingForServer = false;
            this.currentCardPos = null;
            this._playCurrent();
        }

        primeSequence(seq, pointer = 0) {
            if (!Array.isArray(seq)) return;
            this.stop();
            this.queue = seq.map((item) => ({
                cardPos: typeof item.cardPos === 'number' ? item.cardPos : null,
                letter: item.letter | 0,
            }));
            this.pointer = Math.max(0, Math.min(this.queue.length - 1, Number(pointer) || 0));
            this.playing = false;
            this.waitingForTake = false;
            this.waitingForServer = true;
            this.currentCardPos = null;
        }

        getCurrentCardPos() {
            return this.currentCardPos;
        }

        _playCurrent() {
            if (this.pointer < 0 || this.pointer >= this.queue.length) {
                this.playing = false;
                return;
            }
            const item = this.queue[this.pointer];
            this.currentCardPos = item.cardPos;
            const audio = this.audios[item.letter];
            if (!audio) {
                console.warn('missing audio for', item.letter);
                if (item.cardPos === null) {
                    this._safeAck(this.pointer);
                    setTimeout(() => {
                        this.pointer++;
                        if (this.pointer < this.queue.length) this._playCurrent();
                        else this.playing = false;
                    }, 300);
                    return;
                }
                this.waitingForTake = true;
                return;
            }
            try {
                audio.currentTime = 0;
                audio.play().catch((e) => console.warn('audio play fail', e));
            } catch (err) {
                console.warn('audio play exception', err);
            }
            this.playing = true;
            if (item.cardPos === null) {
                this.waitingForTake = false;
                audio.onended = null;
                audio.onended = () => {
                    try { audio.onended = null; } catch (e) { }
                    this._safeAck(this.pointer);
                    this.waitingForServer = true;
                };
            } else {
                this.waitingForTake = true;
            }
        }

        _safeAck(index) {
            try {
                this.sendPlayAck(index);
            } catch (err) {
                console.warn('play ack send failed', err);
            }
        }

        onPlayContinue(index) {
            const idx = Number(index);
            if (Number.isNaN(idx)) return;
            if (this.waitingForServer && this.pointer === idx) {
                this.waitingForServer = false;
                this.pointer++;
                if (this.pointer < this.queue.length) this._playCurrent();
                else this.playing = false;
            }
        }

        onCardTaken(cardPos) {
            if (!this.playing) return;
            if (this.currentCardPos === cardPos && this.waitingForTake) {
                this.waitingForTake = false;
                const current = this.queue[this.pointer];
                const audio = current ? this.audios[current.letter] : null;
                if (audio) {
                    try {
                        audio.onended = null;
                        audio.pause();
                        audio.currentTime = 0;
                    } catch (err) { }
                }
                setTimeout(() => {
                    this.pointer++;
                    if (this.pointer < this.queue.length) this._playCurrent();
                    else this.playing = false;
                }, 3000);
            } else {
                this.queue = this.queue.filter((item, idx) => !(item.cardPos === cardPos && idx > this.pointer));
            }
        }

        playFromIndex(index) {
            const idx = Number(index);
            if (Number.isNaN(idx) || idx < 0 || idx >= this.queue.length) return;
            this.pointer = idx;
            this.waitingForServer = false;
            if (!this.playing) this._playCurrent();
        }

        stop() {
            if (this.playing && this.queue[this.pointer]) {
                const current = this.queue[this.pointer];
                const audio = this.audios[current.letter];
                if (audio) {
                    try {
                        audio.onended = null;
                        audio.pause();
                        audio.currentTime = 0;
                    } catch (err) { }
                }
            }
            this.queue = [];
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.waitingForServer = false;
            this.currentCardPos = null;
        }
    }

    global.AudioManager = AudioManager;
})(window);
