document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');
    const renderer = new Renderer(canvas);
    const chat = new ChatUI();
    const statusEl = document.getElementById('status');
    const btnJoin = document.getElementById('btnJoin');
    const inpName = document.getElementById('inpName');
    const inpRoom = document.getElementById('inpRoom');
    const selRole = document.getElementById('selRole');

    let ws = null;
    let myPlayerId = '';
    let mySpectatorId = '';
    let myRole = '';
    let roomId = '';

    function setStatus(s) { statusEl.textContent = s; }

    btnJoin.addEventListener('click', async () => {
        const name = inpName.value.trim();
        if (!name) { alert('名前を入力してください'); return; }
        const room = inpRoom.value.trim() || null;
        const role = selRole.value || 'player';
        // connect
        const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
        ws = new WSClient();
        ws.onmessage = handleMessage;
        ws.onopen = () => setStatus('接続済み');
        ws.onclose = () => setStatus('切断');
        try {
            await ws.connect(url);
        } catch (e) {
            alert('WebSocket に接続できません: ' + e);
            return;
        }
        // send join
        const joinMsg = { type: 'join', room_id: room, role: role, name: name };
        ws.sendObj(joinMsg);
        setStatus('joining...');
    });

    function handleMessage(msg) {
        const t = msg.type;
        if (t === 'joined') {
            roomId = msg.room_id;
            const you = msg.you || {};
            if (you.player_id) myPlayerId = you.player_id;
            if (you.spectator_id) mySpectatorId = you.spectator_id;
            myRole = you.player_id ? 'player' : (you.spectator_id ? 'spectator' : '');
            setStatus('joined ' + roomId + ' as ' + myRole);
            chat.pushMessage('', 'joined: ' + roomId);
        } else if (t === 'snapshot') {
            const room = msg.room || {};
            renderer.setState(room.owners || [], room.card_letters || []);
            // players -> array of {player_id, name}
            const players = (room.players || []).map(p => [p.player_id, p.name]);
            const spectators = (room.spectators || []).map(s => [s.spectator_id, s.name]);
            chat.setRoomInfo(room.room_id, players, spectators, '');
        } else if (t === 'player_action') {
            const payload = msg.payload || {};
            if (payload && payload.payload && typeof payload.payload === 'object' && payload.payload.id !== undefined) {
                // note: server uses nested payload in evt.payload.payload in some places; normalize
            }
            // server event payload used in server_ws.py: payload includes id and player
            const p = msg.payload || {};
            if (p && p.action && p.action === 'take') {
                const cid = p.payload && p.payload.id;
                const playerName = p.payload && p.payload.player;
                if (typeof cid === 'number') {
                    const owners = renderer.owners.slice();
                    owners[cid] = playerName || owners[cid];
                    renderer.setState(owners, renderer.cardLetters);
                    chat.pushMessage('', (playerName || '') + ' took ' + cid);
                }
            }
        } else if (t === 'player_joined') {
            const name = msg.payload && msg.payload.name;
            chat.pushMessage('', name + ' joined');
        } else if (t === 'chat_message') {
            const payload = msg.payload || {};
            chat.pushMessage(payload.from || '', payload.message || '');
        } else if (t === 'error') {
            chat.pushMessage('server', 'error: ' + (msg.error || 'unknown'));
        } else {
            // other events
            // some server events wrap payload differently; try to update owners/card_letters when present
            const room = msg.room;
            if (room && (room.owners || room.card_letters)) {
                renderer.setState(room.owners || [], room.card_letters || []);
            }
        }
    }

    // chat send callback -> send 'chat' message via ws
    chat.setSendCallback((text) => {
        if (!ws) return;
        const out = { type: 'chat', room_id: roomId };
        if (myPlayerId) out.player_id = myPlayerId;
        if (mySpectatorId) out.spectator_id = mySpectatorId;
        out.payload = { message: text };
        ws.sendObj(out);
    });

    // canvas click -> compute card id and send 'action' take
    canvas.addEventListener('click', (ev) => {
        const r = canvas.getBoundingClientRect();
        const mx = ev.clientX - r.left;
        const my = ev.clientY - r.top;
        const cid = renderer.cardAtPosition(mx, my);
        if (cid >= 0) {
            // if owned, ignore
            if (renderer.owners[cid]) return;
            const playerId = myPlayerId || mySpectatorId || '';
            const out = { type: 'action', player_id: myPlayerId, action: 'take', payload: { id: cid, player: document.getElementById('inpName').value } };
            if (ws) ws.sendObj(out);
        }
    });
});
