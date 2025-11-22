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
            try {
                this.ws = new WebSocket(url);
            } catch (e) {
                reject(e);
                return;
            }
            this.ws.addEventListener('open', (ev) => {
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
            this.ws.addEventListener('close', (ev) => { if (this.onclose) this.onclose(ev); });
            this.ws.addEventListener('error', (ev) => { if (this.onerror) this.onerror(ev); });
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
