// 簡易 WebSocket ラッパー（ブラウザ用）
// - JSON メッセージの送受信を簡潔に扱うための小さなユーティリティ
// - onmessage/onopen/onclose/onerror コールバックをサポート
// 変更は極力行わず、既存の API を保つようにしています。
//
// Simple WebSocket wrapper for browser
class WSClient {
    constructor() {
        this.ws = null;
        this.onmessage = null; // function(json)
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
    }

    connect(url) {
        return new Promise((resolve, reject) => {
            let opened = false;
            try {
                this.ws = new WebSocket(url);
            } catch (e) {
                reject(e);
                return;
            }
            this.ws.addEventListener('open', (ev) => {
                opened = true;
                if (this.onopen) this.onopen(ev);
                resolve();
            });
            this.ws.addEventListener('message', (ev) => {
                try {
                    const j = JSON.parse(ev.data);
                    if (this.onmessage) this.onmessage(j);
                } catch (e) {
                    console.warn('ws parse error', e);
                }
            });
            this.ws.addEventListener('close', (ev) => {
                if (!opened) {
                    reject(new Error('WebSocket closed before open (code=' + (ev.code || 0) + ')'));
                }
                if (this.onclose) this.onclose(ev);
            });
            this.ws.addEventListener('error', (ev) => {
                if (!opened) {
                    reject(new Error('WebSocket error before open'));
                }
                if (this.onerror) this.onerror(ev);
            });
        });
    }

    sendObj(obj) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try {
            this.ws.send(JSON.stringify(obj));
            return true;
        } catch (e) { return false; }
    }

    close() { if (this.ws) this.ws.close(); }
}

window.WSClient = WSClient;
