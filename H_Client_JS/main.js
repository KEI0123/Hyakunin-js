document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');
    const renderer = new Renderer(canvas);
    const chat = new ChatUI();
    const statusEl = document.getElementById('status');
    const btnConnect = document.getElementById('btnConnect');
    const btnCreate = document.getElementById('btnCreate');
    const inpName = document.getElementById('inpName');
    const inpRoom = document.getElementById('inpRoom');
    // role selection removed; server will default to spectator when role omitted
    const btnBack = document.getElementById('btnBack');
    const btnBecome = document.getElementById('btnBecome');
    const btnWithdraw = document.getElementById('btnWithdraw');

    let ws = null;
    let myPlayerId = '';
    let mySpectatorId = '';
    let myRole = '';
    let pendingLeaveResolver = null;
    let roomId = '';
    let selectedTile = null; // index of lobby tile user clicked (0..9)
    // Fixed room IDs room01..room10
    const tileRoomIds = Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        return 'room' + (n < 10 ? '0' + n : '' + n);
    }); // map tile->roomId (fixed)

    function setStatus(s) { statusEl.textContent = s; }

    // Lobby rendering: create 10 tiles (5x2)
    const lobbyGrid = document.getElementById('lobbyGrid');
    function renderLobby() {
        lobbyGrid.innerHTML = '';
        for (let i = 0; i < 10; ++i) {
            const tile = document.createElement('div');
            tile.className = 'roomTile' + (tileRoomIds[i] ? '' : ' empty');
            tile.dataset.index = i;
            const title = document.createElement('div');
            title.className = 'title';
            title.textContent = tileRoomIds[i] ? ('Room ' + tileRoomIds[i]) : ('空き部屋 #' + (i + 1));
            const sub = document.createElement('div');
            sub.className = 'sub';
            sub.textContent = tileRoomIds[i] ? 'Click to join' : 'Click to create & join';
            tile.appendChild(title);
            tile.appendChild(sub);
            tile.addEventListener('click', () => onTileClick(i, tile));
            lobbyGrid.appendChild(tile);
        }
    }

    function onTileClick(index, tileEl) {
        // Save selected tile to update when server returns joined room_id
        selectedTile = index;
        // If tile already has a roomId, set inpRoom to that and join; otherwise create new room by joining with empty id
        const targetRoom = tileRoomIds[index] || null;
        inpRoom.value = targetRoom || '';
        // Trigger create flow programmatically (create/join)
        btnCreate.click();
    }

    // show/hide views
    const lobbyView = document.getElementById('lobbyView');
    const gameView = document.getElementById('gameView');
    function showGameView() { lobbyView.style.display = 'none'; gameView.style.display = 'flex'; renderer.resize(); }
    function showLobbyView() { lobbyView.style.display = ''; gameView.style.display = 'none'; }

    // initial lobby render
    renderLobby();

    // Connect button: only establish WebSocket connection (do not send join)
    btnConnect.addEventListener('click', async () => {
        let url = document.getElementById('inpWsUrl').value.trim();
        if (!url) url = 'wss://hyakunin-js.onrender.com/ws';
        if (ws) { console.log('Already connected'); setStatus('接続済み'); return; }
        console.log('Connecting to WS URL (connect only):', url);
        ws = new WSClient();
        ws.onmessage = handleMessage;
        ws.onopen = (ev) => { console.log('ws open', ev); setStatus('接続済み'); };
        ws.onclose = (ev) => { console.log('ws close', ev); setStatus('切断'); ws = null; };
        ws.onerror = (ev) => { console.error('ws error', ev); };
        try {
            await ws.connect(url);
        } catch (e) {
            console.error('WebSocket connect failed:', e);
            setStatus('切断');
            alert('WebSocket に接続できません: ' + (e && e.message ? e.message : e));
            ws = null;
            return;
        }
    });

    // Create button: ensure connection then send join (this preserves previous "join" behavior)
    btnCreate.addEventListener('click', async () => {
        const name = inpName.value.trim();
        if (!name) { alert('名前を入力してください'); return; }
        const room = inpRoom.value.trim() || null;
        // omit role so server uses its default (spectator when role not provided)
        let url = document.getElementById('inpWsUrl').value.trim();
        if (!url) url = 'wss://hyakunin-js.onrender.com/ws';
        if (!ws) {
            console.log('Connecting to WS URL for create:', url);
            ws = new WSClient();
            ws.onmessage = handleMessage;
            ws.onopen = (ev) => { console.log('ws open', ev); setStatus('接続済み'); };
            ws.onclose = (ev) => { console.log('ws close', ev); setStatus('切断'); ws = null; };
            ws.onerror = (ev) => { console.error('ws error', ev); };
            try {
                await ws.connect(url);
            } catch (e) {
                console.error('WebSocket connect failed:', e);
                setStatus('切断');
                alert('WebSocket に接続できません: ' + (e && e.message ? e.message : e));
                ws = null;
                return;
            }
        }
        const joinMsg = { type: 'join', room_id: room, name: name };
        console.log('sending join', joinMsg);
        ws.sendObj(joinMsg);
        setStatus('joining...');
    });

    // Back button: send leave, clear local state, show lobby
    btnBack.addEventListener('click', async () => {
        // send leave if connected and we have role/id
        if (ws && (myPlayerId || mySpectatorId || myRole)) {
            const leaveMsg = { type: 'leave', role: myRole };
            if (myPlayerId) leaveMsg.player_id = myPlayerId;
            if (mySpectatorId) leaveMsg.spectator_id = mySpectatorId;
            try {
                // Prepare a promise that resolves when server confirms leave
                const leavePromise = new Promise((resolve) => {
                    pendingLeaveResolver = resolve;
                });
                ws.sendObj(leaveMsg);
                // wait for server broadcast or timeout (1.5s)
                const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
                await Promise.race([leavePromise, timeout]);
            } catch (e) {
                console.warn('leave send failed', e);
            }
            try {
                ws.close();
            } catch (e) { }
            ws = null;
            pendingLeaveResolver = null;
        }
        // reset client-side room/player state
        myPlayerId = '';
        mySpectatorId = '';
        myRole = '';
        if (btnBecome) btnBecome.disabled = true;
        if (btnWithdraw) btnWithdraw.disabled = true;
        roomId = '';
        setStatus('ロビー');
        if (chat && typeof chat.clearMessages === 'function') chat.clearMessages();
        // clear renderer state
        renderer.setState(new Array(10).fill(''), new Array(10).fill(0));
        showLobbyView();
    });

    // Become (spectator -> player) button
    if (btnBecome) {
        btnBecome.addEventListener('click', () => {
            if (!ws) { alert('未接続です'); return; }
            if (myRole === 'player') { alert('既にプレイヤーです'); return; }
            // send become_player; include spectator_id when available
            const out = { type: 'become_player' };
            if (mySpectatorId) out.spectator_id = mySpectatorId;
            // name optional
            const nameVal = document.getElementById('inpName').value.trim();
            if (nameVal) out.name = nameVal;
            ws.sendObj(out);
            setStatus('promoting...');
        });
        btnBecome.disabled = true;
    }

    // Withdraw (player -> spectator) button
    if (btnWithdraw) {
        btnWithdraw.addEventListener('click', () => {
            if (!ws) { alert('未接続です'); return; }
            if (myRole !== 'player') { alert('プレイヤーではありません'); return; }
            const out = { type: 'become_spectator' };
            if (myPlayerId) out.player_id = myPlayerId;
            ws.sendObj(out);
            setStatus('demoting...');
        });
        btnWithdraw.disabled = true;
    }

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
            // If we joined as result of clicking a lobby tile, store mapping and update lobby UI
            if (selectedTile !== null) {
                tileRoomIds[selectedTile] = roomId;
                renderLobby();
                selectedTile = null;
            }
            // switch to game view once joined
            showGameView();
            if (btnBecome) btnBecome.disabled = (myRole === 'player');
            if (btnWithdraw) btnWithdraw.disabled = (myRole !== 'player');
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
        } else if (t === 'player_left' || t === 'spectator_left') {
            // If this is our own leave confirmation, resolve pending promise
            const payload = msg.payload || {};
            if (pendingLeaveResolver) {
                if (t === 'player_left' && payload.player_id && payload.player_id === myPlayerId) {
                    try { pendingLeaveResolver(); } catch (e) { }
                    pendingLeaveResolver = null;
                } else if (t === 'spectator_left' && payload.spectator_id && payload.spectator_id === mySpectatorId) {
                    try { pendingLeaveResolver(); } catch (e) { }
                    pendingLeaveResolver = null;
                }
            }
            // show message to chat as well
            if (t === 'player_left') {
                chat.pushMessage('', (payload.player_id || '') + ' left');
            } else {
                chat.pushMessage('', (payload.spectator_id || '') + ' left');
            }
        } else if (t === 'promoted') {
            const you = msg.you || {};
            if (you.player_id) myPlayerId = you.player_id;
            if (you.spectator_id) mySpectatorId = you.spectator_id;
            myRole = you.player_id ? 'player' : (you.spectator_id ? 'spectator' : myRole);
            setStatus('joined ' + roomId + ' as ' + myRole);
            chat.pushMessage('', 'promoted to player');
            if (btnBecome) btnBecome.disabled = (myRole === 'player');
            if (btnWithdraw) btnWithdraw.disabled = (myRole !== 'player');
        } else if (t === 'chat_message') {
            const payload = msg.payload || {};
            chat.pushMessage(payload.from || '', payload.message || '');
        } else if (t === 'demoted') {
            const you = msg.you || {};
            if (you.spectator_id) mySpectatorId = you.spectator_id;
            if (you.player_id) myPlayerId = you.player_id;
            myRole = you.spectator_id ? 'spectator' : myRole;
            setStatus('joined ' + roomId + ' as ' + myRole);
            chat.pushMessage('', 'you are now spectator');
            if (btnBecome) btnBecome.disabled = (myRole === 'player');
            if (btnWithdraw) btnWithdraw.disabled = (myRole !== 'player');
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
            // only players can take
            if (myRole !== 'player') { alert('参加（プレイヤー）として参加してください'); return; }
            const out = { type: 'action', player_id: myPlayerId, action: 'take', payload: { id: cid, player: document.getElementById('inpName').value } };
            if (ws) ws.sendObj(out);
        }
    });
});
