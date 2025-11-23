class ChatUI {
    constructor() {
        this.messagesEl = document.getElementById('messages');
        this.playersEl = document.getElementById('playersList');
        this.roomInfoEl = document.getElementById('roomInfo');
        this.sendCb = null;
        document.getElementById('btnSend').addEventListener('click', () => this._send());
        document.getElementById('inpChat').addEventListener('keypress', (e) => { if (e.key === 'Enter') this._send(); });
    }

    _send() {
        const v = document.getElementById('inpChat').value.trim();
        if (!v) return;
        document.getElementById('inpChat').value = '';
        if (this.sendCb) this.sendCb(v);
    }

    pushMessage(from, msg) {
        const d = document.createElement('div');
        d.textContent = (from ? (from + ': ') : '') + msg;
        this.messagesEl.appendChild(d);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    setRoomInfo(roomId, players, spectators, myName) {
        this.roomInfoEl.textContent = roomId ? ('Room ' + roomId) : '';
        // Render players and spectators inline for a compact view
        // players: array of [id, name], spectators: array of [id, name]
        const playerNames = players.map(p => p[1]).join(', ');
        const specNames = spectators.map(s => s[1]).join(', ');
        // Build inline HTML with labels and small class names for styling
        let html = '';
        html += '<span class="players-label">Players:</span> ' + (playerNames || '—');
        html += ' &nbsp; ';
        html += '<span class="spec-label">Specs:</span> ' + (specNames || '—');
        this.playersEl.innerHTML = html;
    }

    setSendCallback(cb) { this.sendCb = cb; }

    clearMessages() {
        if (this.messagesEl) this.messagesEl.innerHTML = '';
    }
}

window.ChatUI = ChatUI;
