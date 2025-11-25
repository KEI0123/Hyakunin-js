// クライアント側エントリポイント
// このファイルはブラウザ上で動作するクライアントの主要ロジックを含みます。
// - WebSocket 接続の管理
// - 描画（Renderer）との連携
// - オーディオ再生の制御（AudioManager）
// - UI イベントハンドリング（チャット、ルーム参加、カード取得など）
// 日本語コメントを追加して可読性を上げています。ロジックは変更していません。
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
    // sync helpers
    let serverOffsetMs = 0; // estimate: server_time - Date.now()
    let appliedEventIds = new Set();
    let lastSeenEventId = 0;
    let pendingLeaveResolver = null;
    let roomId = '';
    let started = false; // whether the game has started (controls card visibility)
    let pendingSnapshot = null; // store snapshot until start
    let currentPlayers = [];
    let currentSpectators = [];
    let selectedTile = null; // index of lobby tile user clicked (0..9)
    // Fixed room IDs room01..room10
    const tileRoomIds = Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        return 'room' + (n < 10 ? '0' + n : '' + n);
    }); // map tile->roomId (fixed)

    // AudioManager: 音声ファイルをプリロードし、順次再生を管理するクラス
    // - onCardTaken 等の外部呼び出しで再生を進めることができる
    // - サーバー提供の play_sequence をそのまま再生する API を提供する
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
            this.waitingForServer = false;
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
            // build queue: include visible table cards (with cardPos) and add 9 random off-table cards
            const items = [];
            const tableLetters = Array.isArray(cardLetters) ? cardLetters.slice(0, 10) : [];
            const presentSet = new Set(tableLetters.map(x => x | 0));
            // add visible table cards (preserve their card positions)
            for (let i = 0; i < 10; i++) {
                if (!owners || !owners[i]) {
                    const letter = (tableLetters && typeof tableLetters[i] !== 'undefined') ? (tableLetters[i] | 0) : 0;
                    items.push({ cardPos: i, letter: Math.max(0, Math.min(99, letter)) });
                }
            }
            // select 9 random numbers from 0..99 excluding presentSet
            const pool = [];
            for (let v = 0; v < 100; v++) {
                if (!presentSet.has(v)) pool.push(v);
            }
            // shuffle pool then take first 9
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
            }
            const extraCount = Math.min(9, pool.length);
            for (let k = 0; k < extraCount; k++) {
                items.push({ cardPos: null, letter: pool[k] });
            }
            // finally shuffle the whole 19-item list so playback order is random across both types
            for (let i = items.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const tmp = items[i]; items[i] = items[j]; items[j] = tmp;
            }
            this.queue = items;
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.currentCardPos = null;
            if (this.queue.length > 0) this._playCurrent();
        }

        // Use server-provided sequence (array of {cardPos: int|null, letter: int})
        startSequenceFromServer(seq) {
            if (!Array.isArray(seq)) return;
            this.stop();
            this.queue = seq.map(it => ({ cardPos: (typeof it.cardPos === 'number' ? it.cardPos : null), letter: (it.letter | 0) }));
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.currentCardPos = null;
            // When receiving server sequence, start playback but for off-table items
            // we will wait for server 'play_continue' after sending our local ack
            if (this.queue.length > 0) this._playCurrent();
        }

        _playCurrent() {
            if (this.pointer < 0 || this.pointer >= this.queue.length) { this.playing = false; return; }
            const item = this.queue[this.pointer];
            this.currentCardPos = item.cardPos;
            const audio = this.audios[item.letter];
            if (!audio) {
                console.warn('missing audio for', item.letter);
                // if missing audio for an off-table item, just advance after short delay
                if (item.cardPos === null) {
                    // send ack to server if we are a player so server can coordinate
                    try { if (ws && typeof ws.sendObj === 'function') ws.sendObj({ type: 'play_ack', player_id: myPlayerId || mySpectatorId || null, index: this.pointer }); } catch (e) { }
                    setTimeout(() => { this.pointer++; if (this.pointer < this.queue.length) this._playCurrent(); else this.playing = false; }, 300);
                    return;
                }
                this.waitingForTake = true;
                return;
            }
            try { audio.currentTime = 0; audio.play().catch(e => console.warn('audio play fail', e)); } catch (e) { console.warn('audio play exception', e); }
            this.playing = true;
            // If the current item refers to an on-table card (cardPos != null), block advancing until it's taken.
            // If it's an off-table item (cardPos === null), advance automatically when playback ends.
            if (item.cardPos === null) {
                this.waitingForTake = false;
                // remove any previous handler
                audio.onended = null;
                audio.onended = () => {
                    // clear handler to avoid double calls
                    try { audio.onended = null; } catch (e) { }
                    // notify server that this client finished playing this off-table item
                    try { if (ws && typeof ws.sendObj === 'function') ws.sendObj({ type: 'play_ack', player_id: myPlayerId || mySpectatorId || null, index: this.pointer }); } catch (e) { }
                    // Wait for server 'play_continue' to advance to next item. Server will broadcast when all players ack.
                    this.waitingForServer = true;
                };
            } else {
                this.waitingForTake = true;
            }
        }

        // Called when server broadcasts that it's okay to continue from index
        onPlayContinue(index) {
            try {
                const idx = Number(index);
                if (isNaN(idx)) return;
                // only advance if we're currently waiting for server and index matches current pointer
                if (this.waitingForServer && this.pointer === idx) {
                    this.waitingForServer = false;
                    this.pointer++;
                    if (this.pointer < this.queue.length) this._playCurrent(); else this.playing = false;
                }
            } catch (e) { }
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
                    if (a) { try { a.onended = null; } catch (e) { } a.pause(); try { a.currentTime = 0; } catch (e) { } }
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
                if (a) { try { a.onended = null; a.pause(); a.currentTime = 0; } catch (e) { } }
            }
            this.queue = [];
            this.pointer = 0;
            this.playing = false;
            this.waitingForTake = false;
            this.currentCardPos = null;
            this.waitingForServer = false;
        }
    }

    const audioManager = new AudioManager();

    // UI ステータス表示を更新するユーティリティ
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

    // サーバーから受け取ったメッセージを処理する中央ハンドラ
    // type に応じて snapshot/player_action/chat/game_* 等を処理する
    function handleMessage(msg) {
        // update server offset if provided by server (simple exponential smoothing)
        try {
            if (msg && msg.server_ts) {
                const srv = Date.parse(msg.server_ts);
                if (!isNaN(srv)) {
                    const measured = srv - Date.now();
                    serverOffsetMs = Math.round((serverOffsetMs * 0.8) + (measured * 0.2));
                }
            }
        } catch (e) { }

        // deduplicate events that include numeric id
        try {
            if (msg && typeof msg.id !== 'undefined' && msg.id !== null) {
                const mid = parseInt(msg.id, 10);
                if (!isNaN(mid)) {
                    if (appliedEventIds.has(mid)) return; // already processed
                    appliedEventIds.add(mid);
                    if (mid > lastSeenEventId) lastSeenEventId = mid;
                }
            }
        } catch (e) { }

        const t = msg.type;
        // DEBUG: uncomment to inspect incoming messages
        // console.log('WS IN:', msg);
        if (t === 'joined') {
            roomId = msg.room_id;
            const you = msg.you || {};
            // Clear per-room event dedupe state when joining a new room
            try { appliedEventIds.clear(); } catch (e) { appliedEventIds = new Set(); }
            lastSeenEventId = 0;
            if (you.player_id) myPlayerId = you.player_id;
            if (you.spectator_id) mySpectatorId = you.spectator_id;
            myRole = you.player_id ? 'player' : (you.spectator_id ? 'spectator' : '');
            setStatus('joined ' + roomId + ' as ' + myRole);
            // Clear previous room chat when joining a new room
            if (chat && typeof chat.clearMessages === 'function') chat.clearMessages();
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
            // Store snapshot. If the room is already started on server, apply immediately
            pendingSnapshot = { owners: room.owners || [], card_letters: room.card_letters || [], play_sequence: room.play_sequence || null, play_at: room.play_at || null };
            // reflect server-side started state for late joiners (spectators)
            try { started = !!room.started; } catch (e) { started = started; }
            // conservatively track last seen event id from snapshot's next_event_id
            try {
                if (typeof msg.next_event_id !== 'undefined' && msg.next_event_id !== null) {
                    const nid = parseInt(msg.next_event_id, 10);
                    if (!isNaN(nid)) lastSeenEventId = Math.max(lastSeenEventId, nid - 1);
                }
            } catch (e) { }
            // Try to fetch recent missing events (one before lastSeenEventId to be safe)
            try { if (room.room_id) fetchMissingEvents(room.room_id, Math.max(0, lastSeenEventId - 1)); } catch (e) { }
            if (started) {
                renderer.setState(pendingSnapshot.owners, pendingSnapshot.card_letters);
                try {
                    const seq = room.play_sequence || pendingSnapshot.play_sequence || null;
                    const playAt = room.play_at || pendingSnapshot.play_at || null;
                    const playIdx = (typeof room.play_idx !== 'undefined' ? room.play_idx : (typeof pendingSnapshot.play_idx !== 'undefined' ? pendingSnapshot.play_idx : 0));
                    // If we're a player, start playback as before. If spectator, load sequence but do not start audio until server signals.
                    if (myRole === 'player') {
                        scheduleSequenceStart(seq, playAt);
                    } else {
                        // load queue without autoplay: set queue and pointer, set waitingForServer so we only advance when server sends play_continue
                        try {
                            if (Array.isArray(seq) && seq.length > 0) {
                                audioManager.stop();
                                audioManager.queue = seq.map(it => ({ cardPos: (typeof it.cardPos === 'number' ? it.cardPos : null), letter: (it.letter | 0) }));
                                audioManager.pointer = Number(playIdx) || 0;
                                audioManager.playing = false;
                                audioManager.waitingForServer = true;
                            }
                        } catch (e) { console.warn('spectator load seq fail', e); }
                    }
                } catch (e) { console.warn('audio start fail', e); }
            }
            // players -> array of [player_id, name]
            currentPlayers = (room.players || []).map(p => [p.player_id, p.name]);
            currentSpectators = (room.spectators || []).map(s => [s.spectator_id, s.name]);
            chat.setRoomInfo(room.room_id, currentPlayers, currentSpectators, '');
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
                try {
                    const seq = (pendingSnapshot && pendingSnapshot.play_sequence) || (p.payload && p.payload.play_sequence) || null;
                    const playAt = (pendingSnapshot && pendingSnapshot.play_at) || (p.payload && p.payload.play_at) || null;
                    scheduleSequenceStart(seq, playAt);
                } catch (e) { console.warn('audio start fail', e); }
            }
        } else if (t === 'player_joined') {
            const payload = msg.payload || {};
            const pid = payload.player_id;
            const name = payload.name || '(unknown)';
            chat.pushMessage('', name + ' joined');
            if (pid) {
                // add to local player list only if not already present
                const exists = currentPlayers.some(p => p[0] === pid);
                if (!exists) {
                    currentPlayers.push([pid, name]);
                    try { chat.setRoomInfo(roomId, currentPlayers, currentSpectators, ''); } catch (e) { }
                }
            }
        } else if (t === 'spectator_joined') {
            const payload = msg.payload || {};
            const sid = payload.spectator_id;
            const name = payload.name || '(unknown)';
            chat.pushMessage('', name + ' joined (spectator)');
            if (sid) {
                const exists = currentSpectators.some(s => s[0] === sid);
                if (!exists) {
                    currentSpectators.push([sid, name]);
                    try { chat.setRoomInfo(roomId, currentPlayers, currentSpectators, ''); } catch (e) { }
                }
            }
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
            // show message to chat as well and update local lists
            if (t === 'player_left') {
                const pidLeft = payload.player_id;
                chat.pushMessage('', (pidLeft || '') + ' left');
                if (pidLeft) {
                    currentPlayers = currentPlayers.filter(p => p[0] !== pidLeft);
                    try { chat.setRoomInfo(roomId, currentPlayers, currentSpectators, ''); } catch (e) { }
                }
            } else {
                const sidLeft = payload.spectator_id;
                chat.pushMessage('', (sidLeft || '') + ' left');
                if (sidLeft) {
                    currentSpectators = currentSpectators.filter(s => s[0] !== sidLeft);
                    try { chat.setRoomInfo(roomId, currentPlayers, currentSpectators, ''); } catch (e) { }
                }
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
            try {
                const seq = (payload && payload.play_sequence) || (pendingSnapshot && pendingSnapshot.play_sequence) || null;
                const playAt = payload && payload.play_at ? payload.play_at : (pendingSnapshot && pendingSnapshot.play_at ? pendingSnapshot.play_at : null);
                scheduleSequenceStart(seq, playAt);
            } catch (e) { console.warn('audio start fail', e); }
        } else if (t === 'game_finished') {
            const payload = msg.payload || {};
            // show winner label if available, else show draw or winner name
            // Prefer showing the winner player's name when available
            if (payload.winner) {
                chat.pushMessage('system', 'winner ' + payload.winner);
                try { renderer.setOverlay('Winner: ' + payload.winner, 6000); } catch (e) { }
            } else if (payload.winner_label) {
                chat.pushMessage('system', 'winner ' + payload.winner_label);
                try { renderer.setOverlay('Winner: ' + payload.winner_label, 6000); } catch (e) { }
            } else {
                chat.pushMessage('system', 'draw');
                try { renderer.setOverlay('Draw', 6000); } catch (e) { }
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
        } else if (t === 'play_continue') {
            // server signals that all players have acked for index -> advance audio
            try { if (audioManager && typeof audioManager.onPlayContinue === 'function') audioManager.onPlayContinue(msg.index); } catch (e) { }
        } else if (t === 'play_item') {
            // server asks clients to play item at index (sync start)
            try {
                if (audioManager && Array.isArray(audioManager.queue) && typeof msg.index !== 'undefined') {
                    const idx = Number(msg.index);
                    if (!isNaN(idx) && idx >= 0 && idx < audioManager.queue.length) {
                        audioManager.pointer = idx;
                        audioManager.waitingForServer = false;
                        if (!audioManager.playing) audioManager._playCurrent();
                    }
                }
            } catch (e) { }
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

    // Schedule sequence start using server-provided play_at (ISO) and serverOffsetMs
    function scheduleSequenceStart(seq, playAt) {
        try {
            if (playAt) {
                const srv = Date.parse(playAt);
                if (!isNaN(srv)) {
                    const localStart = srv - serverOffsetMs;
                    const delay = localStart - Date.now();
                    if (delay > 50) {
                        setTimeout(() => { try { if (seq) audioManager.startSequenceFromServer(seq); else audioManager.startSequence(renderer.cardLetters, renderer.owners); } catch (e) { } }, delay);
                        return;
                    }
                }
            }
        } catch (e) { }
        if (seq) audioManager.startSequenceFromServer(seq); else audioManager.startSequence(renderer.cardLetters, renderer.owners);
    }

    // Fetch missing events from server HTTP API and feed them into handleMessage
    async function fetchMissingEvents(roomId, sinceId) {
        try {
            let base = '';
            try {
                const wsUrl = (document.getElementById('inpWsUrl') && document.getElementById('inpWsUrl').value) ? document.getElementById('inpWsUrl').value.trim() : '';
                if (wsUrl.startsWith('wss://')) base = 'https://' + wsUrl.substring(6).split('/')[0];
                else if (wsUrl.startsWith('ws://')) base = 'http://' + wsUrl.substring(5).split('/')[0];
            } catch (e) { }
            const fetchUrl = (base ? base : '') + '/rooms/' + encodeURIComponent(roomId) + '/events?since_id=' + encodeURIComponent(sinceId || 0);
            const resp = await fetch(fetchUrl);
            if (!resp.ok) return;
            const j = await resp.json();
            if (!j || !Array.isArray(j.events)) return;
            for (const ev of j.events) {
                try { handleMessage(ev); } catch (e) { }
            }
        } catch (e) { console.warn('fetchMissingEvents failed', e); }
    }

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
                        if (window._errAudio) { window._errAudio.currentTime = 0; window._errAudio.play().catch(() => { }); }
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
