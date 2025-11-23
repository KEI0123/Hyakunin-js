// Rendering utilities for canvas-based client
class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.baseImg = new Image();
        this.sheetImg = new Image();
        // asset load flags
        this.baseImgLoaded = false;
        this.sheetImgLoaded = false;
        this.baseImg.onload = () => { this.baseImgLoaded = true; this.draw(); };
        this.baseImg.onerror = (e) => { console.error('Failed to load base image:', this.baseImg.src, e); this.baseImgLoaded = false; };
        this.sheetImg.onload = () => { this.sheetImgLoaded = true; this.draw(); };
        this.sheetImg.onerror = (e) => { console.error('Failed to load sheet image:', this.sheetImg.src, e); this.sheetImgLoaded = false; };
        this.baseImg.src = './dat/image/card.png';
        this.sheetImg.src = './dat/image/m_sheet.png';

        this.cardLetters = new Array(10).fill(0);
        this.owners = new Array(10).fill('');
        // don't reveal cards until the game starts; `setState` will reveal
        this.revealed = false;

        window.addEventListener('resize', () => this.resize());
        this.resize();
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.max(400, rect.width);
        this.canvas.height = Math.max(300, rect.height);
        this.draw();
    }

    setState(owners, cardLetters) {
        if (owners) this.owners = owners.slice();
        if (cardLetters) this.cardLetters = cardLetters.slice();
        // mark cards as revealed when state is explicitly set
        this.revealed = true;
        this.draw();
    }

    draw() {
        const ctx = this.ctx;
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        ctx.fillStyle = '#001';
        ctx.fillRect(0, 0, cw, ch);

        const aspect = 740 / 530;
        // if not yet revealed, draw only background and return
        if (!this.revealed) {
            return;
        }

        const cardW = Math.floor(cw / 6);
        const cardH = Math.floor(cardW * aspect);
        const gap = Math.floor(cardW / 6);
        const topY = gap + 8;
        const oppY = ch - cardH - gap;
        const startX = gap;

        // top row: skip taken cards
        for (let i = 0; i < 5; i++) {
            const x = startX + i * (cardW + gap);
            if (!this.owners[i]) {
                this._drawCard(x, topY, cardW, cardH, this.cardLetters[i], 180);
            }
        }

        // bottom row: skip taken cards
        for (let i = 0; i < 5; i++) {
            const x = startX + i * (cardW + gap);
            const idx = 5 + i;
            if (!this.owners[idx]) {
                this._drawCard(x, oppY, cardW, cardH, this.cardLetters[idx], 0);
            }
        }
    }

    _drawCard(x, y, w, h, letterIdx, angle) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate(angle * Math.PI / 180);
        ctx.translate(-w / 2, -h / 2);
        // draw base card or fallback rectangle
        if (this.baseImgLoaded) {
            try { ctx.drawImage(this.baseImg, 0, 0, w, h); } catch (e) { console.error('drawImage base failed', e); }
        } else {
            ctx.fillStyle = '#223';
            ctx.fillRect(0, 0, w, h);
        }

        // draw letter sprite from sheet if available
        if (this.sheetImgLoaded && this.sheetImg.width > 0 && this.sheetImg.height > 0) {
            const idx = Math.max(0, Math.min(99, letterIdx | 0));
            const row = Math.floor(idx / 10);
            const col = idx % 10;
            const cellW = this.sheetImg.width / 10;
            const cellH = this.sheetImg.height / 10;
            try { ctx.drawImage(this.sheetImg, col * cellW, row * cellH, cellW, cellH, 0, 0, w, h); } catch (e) { console.error('drawImage sheet failed', e); }
        } else {
            // fallback: draw an index number in the center
            ctx.fillStyle = '#88a';
            ctx.font = Math.max(12, Math.floor(w / 4)) + 'px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(letterIdx), w / 2, h / 2);
        }
        ctx.restore();
    }

    // owner rect drawing removed — owner frames are not used when hiding taken cards

    cardAtPosition(mx, my) {
        const cw = this.canvas.width;
        const cardW = Math.floor(cw / 6);
        const gap = Math.floor(cardW / 6);
        const startX = gap;
        const topY = gap + 8;
        const cardH = Math.floor(cardW * (740 / 530));
        const oppY = this.canvas.height - cardH - gap;
        // top
        if (my >= topY && my <= topY + cardH) {
            const idx = Math.floor((mx - startX) / (cardW + gap));
            if (idx >= 0 && idx < 5) return this.owners[idx] ? -1 : idx;
        }
        if (my >= oppY && my <= oppY + cardH) {
            const idx = Math.floor((mx - startX) / (cardW + gap));
            if (idx >= 0 && idx < 5) return this.owners[5 + idx] ? -1 : 5 + idx;
        }
        return -1;
    }
}

window.Renderer = Renderer;
