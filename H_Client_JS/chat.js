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
        this.playersEl.textContent = 'Players: ' + (players.map(p => p[1]).join(', '));
    }

    setSendCallback(cb) { this.sendCb = cb; }
}

window.ChatUI = ChatUI;
