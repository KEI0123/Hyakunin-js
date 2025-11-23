document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');
    const renderer = new Renderer(canvas);
    const chat = new ChatUI();
    const statusEl = document.getElementById('status');
    const btnCreate = document.getElementById('btnCreate');
    const inpName = document.getElementById('inpName');
    const inpRoom = document.getElementById('inpRoom');
    // role selection removed; server will default to spectator when role omitted
    const btnBack = document.getElementById('btnBack');
    const btnStart = document.getElementById('btnStart');
    const btnBecome = document.getElementById('btnBecome');
    const btnWithdraw = document.getElementById('btnWithdraw');

    let ws = null;
    let myPlayerId = '';
    let mySpectatorId = '';
    let myRole = '';
    let pendingLeaveResolver = null;
    let roomId = '';
    let started = false; // whether the game has started (controls card visibility)
    let pendingSnapshot = null; // store snapshot until start
    let selectedTile = null; // index of lobby tile user clicked (0..9)
    // Fixed room IDs room01..room10
    const tileRoomIds = Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        return 'room' + (n < 10 ? '0' + n : '' + n);
    }); // map tile->roomId (fixed)

    // AudioManager: preload kiri00..kiri99 and manage sequential playback
    class AudioManager {
        constructor(basePath = './dat/wav/kiri/', count = 100, ext = '.wav') {
            this.basePath = basePath;
            this.count = count;
            this.ext = ext;
            this.audios = new Array(count).fill(null);
            this.queue = []; // {cardPos, letter}
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.currentCardPos = null;
            this._preloadAll();
        }

        _preloadAll() {
            for (let i = 0; i < this.count; i++) {
                const name = 'kiri' + String(i).padStart(2, '0') + this.ext;
                const a = new Audio(this.basePath + name);
                a.preload = 'auto';
                a.addEventListener('error', (e) => console.warn('audio load error', name, e));
                this.audios[i] = a;
            }
        }

        startSequence(cardLetters, owners) {
            this.stop();
            this.queue = [];
            // build queue in display order 0..9, include only visible (owners empty)
            for (let i = 0; i < 10; i++) {
                if (!owners || !owners[i]) {
                    const letter = (cardLetters && typeof cardLetters[i] !== 'undefined') ? (cardLetters[i] | 0) : 0;
                    this.queue.push({ cardPos: i, letter: Math.max(0, Math.min(99, letter)) });
                }
            }
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.currentCardPos = null;
            if (this.queue.length > 0) this._playCurrent();
        }

        _playCurrent() {
            if (this.pointer < 0 || this.pointer >= this.queue.length) { this.playing = false; return; }
            const item = this.queue[this.pointer];
            this.currentCardPos = item.cardPos;
            const audio = this.audios[item.letter];
            if (!audio) { console.warn('missing audio for', item.letter); this.waitingForTake = true; return; }
            try { audio.currentTime = 0; audio.play().catch(e => console.warn('audio play fail', e)); } catch (e) { console.warn('audio play exception', e); }
            this.playing = true;
            this.waitingForTake = true; // block advancing until card is taken
        }

        onCardTaken(cardPos) {
            // If the currently-waiting card was taken, advance after 3s
            if (!this.playing) return;
            if (this.currentCardPos === cardPos && this.waitingForTake) {
                this.waitingForTake = false;
                // stop current audio immediately
                try {
                    const it = this.queue[this.pointer];
                    const a = this.audios[it.letter];
                    if (a) { a.pause(); try { a.currentTime = 0; } catch (e) { } }
                } catch (e) { }
                // after 3s advance to next
                setTimeout(() => {
                    this.pointer++;
                    if (this.pointer < this.queue.length) this._playCurrent();
                    else this.playing = false;
                }, 3000);
            } else {
                // remove any future queue entries that correspond to this cardPos
                this.queue = this.queue.filter((it, idx) => !(it.cardPos === cardPos && idx > this.pointer));
            }
        }

        stop() {
            // stop current audio if playing
            if (this.playing && this.queue[this.pointer]) {
                const it = this.queue[this.pointer];
                const a = this.audios[it.letter];
                if (a) { try { a.pause(); a.currentTime = 0; } catch (e) { } }
            }
            this.queue = [];
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.currentCardPos = null;
        }
    }

    const audioManager = new AudioManager();

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

    // Connect button removed; connection is established when creating/joining a room

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
        try { audioManager.stop(); } catch (e) { }
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
        // DEBUG: uncomment to inspect incoming messages
        // console.log('WS IN:', msg);
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
            // switch to game view once joined (do not show cards until started)
            started = false;
            pendingSnapshot = null;
            showGameView();
            if (btnBecome) btnBecome.disabled = (myRole === 'player');
            if (btnWithdraw) btnWithdraw.disabled = (myRole !== 'player');
            // show start button only for players
            if (btnStart) {
                if (myRole === 'player') {
                    btnStart.style.display = '';
                    btnStart.disabled = false;
                } else {
                    btnStart.style.display = 'none';
                }
            }
        } else if (t === 'snapshot') {
            const room = msg.room || {};
            // Do not immediately display snapshot cards until the game is started.
            // Store snapshot and apply when started.
            pendingSnapshot = { owners: room.owners || [], card_letters: room.card_letters || [] };
            if (started) {
                renderer.setState(pendingSnapshot.owners, pendingSnapshot.card_letters);
                try { audioManager.startSequence(pendingSnapshot.card_letters || [], pendingSnapshot.owners || []); } catch (e) { console.warn('audio start fail', e); }
            }
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
                    try { audioManager.onCardTaken(cid); } catch (e) { }
                    chat.pushMessage('', (playerName || '') + ' took ' + cid);
                }
            }
            // start action: reveal cards and enable gameplay
            else if (p && p.action && p.action === 'start') {
                // mark started and apply pending snapshot if present
                started = true;
                if (pendingSnapshot) {
                    renderer.setState(pendingSnapshot.owners || [], pendingSnapshot.card_letters || []);
                }
                // hide start button for everyone after start
                if (btnStart) btnStart.style.display = 'none';
                try { audioManager.startSequence(renderer.cardLetters, renderer.owners); } catch (e) { console.warn('audio start fail', e); }
            }
        } else if (t === 'player_joined') {
            const name = msg.payload && msg.payload.name;
            chat.pushMessage('', name + ' joined');
        } else if (t === 'player_penalty') {
            const payload = msg.payload || {};
            const pname = payload.player || '(unknown)';
            const pen = payload.penalties || 0;
            chat.pushMessage('system', `${pname} お手つき -1 (total: ${pen})`);
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
            // show start button when promoted to player
            if (btnStart) {
                if (myRole === 'player') {
                    btnStart.style.display = '';
                    btnStart.disabled = false;
                } else {
                    btnStart.style.display = 'none';
                }
            }
        } else if (t === 'chat_message') {
            const payload = msg.payload || {};
            chat.pushMessage(payload.from || '', payload.message || '');
        } else if (t === 'game_started') {
            // server indicates the game was started by a player
            const payload = msg.payload || {};
            chat.pushMessage('system', (payload.player || 'Someone') + ' started the game');
            started = true;
            if (pendingSnapshot) {
                renderer.setState(pendingSnapshot.owners || [], pendingSnapshot.card_letters || []);
            }
            if (btnStart) btnStart.style.display = 'none';
            try { audioManager.startSequence(renderer.cardLetters, renderer.owners); } catch (e) { console.warn('audio start fail', e); }
        } else if (t === 'game_finished') {
            const payload = msg.payload || {};
            // show winner label if available, else show draw or winner name
            if (payload.winner_label) {
                chat.pushMessage('system', 'winner ' + payload.winner_label);
            } else if (payload.winner) {
                chat.pushMessage('system', 'winner ' + payload.winner);
            } else {
                chat.pushMessage('system', 'draw');
            }
            // mark not started
            started = false;
            try { audioManager.stop(); } catch (e) { }
            // optional: reveal final counts in chat
            if (payload.counts) {
                for (const [name, cnt] of Object.entries(payload.counts)) {
                    chat.pushMessage('system', `${name}: ${cnt}`);
                }
            }
        } else if (t === 'demoted') {
            const you = msg.you || {};
            if (you.spectator_id) mySpectatorId = you.spectator_id;
            if (you.player_id) myPlayerId = you.player_id;
            myRole = you.spectator_id ? 'spectator' : myRole;
            setStatus('joined ' + roomId + ' as ' + myRole);
            chat.pushMessage('', 'you are now spectator');
            if (btnBecome) btnBecome.disabled = (myRole === 'player');
            if (btnWithdraw) btnWithdraw.disabled = (myRole !== 'player');
            // hide start button if demoted to spectator
            if (btnStart) btnStart.style.display = 'none';
        } else if (t === 'error') {
            chat.pushMessage('server', 'error: ' + (msg.error || 'unknown'));
        } else {
            // other events
            // some server events wrap payload differently; try to update owners/card_letters when present
            const room = msg.room;
            if (room && (room.owners || room.card_letters)) {
                // store or apply depending on started state
                pendingSnapshot = { owners: room.owners || [], card_letters: room.card_letters || [] };
                if (started) renderer.setState(pendingSnapshot.owners, pendingSnapshot.card_letters);
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
            if (!started) { alert('ゲームが開始されていません'); return; }
            // Only allow taking the card that is currently being read.
            // If player clicks a non-current card, count as a mistake (penalty) and do NOT send take action.
            try {
                const current = (audioManager && typeof audioManager.currentCardPos !== 'undefined') ? audioManager.currentCardPos : null;
                if (current !== null && current === cid) {
                    const out = { type: 'action', player_id: myPlayerId, action: 'take', payload: { id: cid, player: document.getElementById('inpName').value } };
                    if (ws) ws.sendObj(out);
                } else {
                    // wrong click: increment local penalty and notify user via chat
                    if (typeof window._wrongClickPenalty === 'undefined') window._wrongClickPenalty = 0;
                    window._wrongClickPenalty = (window._wrongClickPenalty || 0) + 1;
                    chat.pushMessage('system', `wrong click: -1 (penalty total: ${window._wrongClickPenalty})`);
                    // notify server about mistake so it can broadcast and apply penalty to scoring
                    try {
                        if (ws && myPlayerId) {
                            const out = { type: 'action', player_id: myPlayerId, action: 'mistake', payload: {} };
                            ws.sendObj(out);
                        }
                    } catch (e) { }
                    // play an optional error sound (if available)
                    try {
                        if (window._errAudio === undefined) window._errAudio = new Audio('./dat/wav/error.wav');
                        if (window._errAudio) { window._errAudio.currentTime = 0; window._errAudio.play().catch(()=>{}); }
                    } catch (e) { }
                }
            } catch (e) {
                // fallback: send take normally if something goes wrong
                const out = { type: 'action', player_id: myPlayerId, action: 'take', payload: { id: cid, player: document.getElementById('inpName').value } };
                if (ws) ws.sendObj(out);
            }
        }
    });

    // Start button: only shown to players; send start action to server
    if (btnStart) {
        btnStart.addEventListener('click', () => {
            if (!ws) { alert('未接続です'); return; }
            if (myRole !== 'player') { alert('プレイヤーでないと開始できません'); return; }
            // send generic action 'start' so server will broadcast a player_action event
            const out = { type: 'action', player_id: myPlayerId, action: 'start', payload: {} };
            try { ws.sendObj(out); } catch (e) { console.warn('start send failed', e); }
            // disable button locally to avoid double sends; will be hidden when start event arrives
            btnStart.disabled = true;
        });
    }
});
