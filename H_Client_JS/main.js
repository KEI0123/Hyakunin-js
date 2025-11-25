// エントリポイント: 各種モジュールを組み合わせてブラウザクライアントを初期化する。
document.addEventListener('DOMContentLoaded', () => {
    const renderer = new Renderer(document.getElementById('gameCanvas'));
    const chat = new ChatUI();
    const state = new GameState();
    const ui = new UIManager();
    let ws = null;

    const audioManager = new AudioManager({
        onPlayAck: (index) => sendPlayAck(index),
    });

    const handleMessage = createServerMessageHandler({
        state,
        ui,
        renderer,
        chat,
        audioManager,
        fetchMissingEvents,
        scheduleSequenceStart,
    });

    ui.on('create', handleCreateOrJoin);
    ui.on('back', handleBackToLobby);
    ui.on('become', handleBecomePlayer);
    ui.on('withdraw', handleWithdrawToSpectator);
    ui.on('start', handleStartGame);
    ui.on('canvas', handleCanvasClick);

    chat.setSendCallback(sendChatMessage);

    renderer.setState(new Array(10).fill(''), new Array(10).fill(0));

    async function handleCreateOrJoin(formState = {}) {
        const name = formState.name || '';
        if (!name) {
            alert('名前を入力してください');
            return;
        }
        const room = formState.room || null;
        const wsUrl = ui.getWsUrlOrDefault(formState.wsUrl || '');
        try {
            await ensureConnection(wsUrl);
        } catch (err) {
            ui.setStatus('切断');
            alert('WebSocket に接続できません: ' + (err && err.message ? err.message : err));
            return;
        }
        const joinMsg = { type: 'join', room_id: room, name };
        ws.sendObj(joinMsg);
        ui.setStatus('joining...');
    }

    async function ensureConnection(url) {
        if (ws) return;
        ws = new WSClient();
        ws.onmessage = handleMessage;
        ws.onopen = () => ui.setStatus('接続済み');
        ws.onclose = () => {
            ui.setStatus(state.getRoomId() ? '切断' : 'ロビー');
            state.clearLeaveResolver();
            ws = null;
            audioManager.setAckCallback(() => { });
        };
        ws.onerror = (ev) => console.error('ws error', ev);
        await ws.connect(url);
        audioManager.setAckCallback((index) => sendPlayAck(index));
    }

    async function handleBackToLobby() {
        if (ws && state.getRole()) {
            const leaveMsg = { type: 'leave', role: state.getRole() };
            if (state.getPlayerId()) leaveMsg.player_id = state.getPlayerId();
            if (state.getSpectatorId()) leaveMsg.spectator_id = state.getSpectatorId();
            try {
                const leavePromise = new Promise((resolve) => state.registerLeaveResolver(resolve));
                ws.sendObj(leaveMsg);
                const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
                await Promise.race([leavePromise, timeout]);
            } catch (err) {
                console.warn('leave send failed', err);
            }
            try { ws.close(); } catch (err) { }
            ws = null;
            state.clearLeaveResolver();
        }
        state.resetRoomState();
        state.resetEventHistory();
        chat.clearMessages();
        renderer.setState(new Array(10).fill(''), new Array(10).fill(0));
        audioManager.stop();
        ui.setStatus('ロビー');
        ui.showLobbyView();
        ui.updateRoleControls('');
    }

    function handleBecomePlayer() {
        if (!ws) { alert('未接続です'); return; }
        if (state.isPlayer()) { alert('既にプレイヤーです'); return; }
        const out = { type: 'become_player' };
        if (state.getSpectatorId()) out.spectator_id = state.getSpectatorId();
        const name = ui.getJoinFormState().name;
        if (name) out.name = name;
        ws.sendObj(out);
        ui.setStatus('promoting...');
    }

    function handleWithdrawToSpectator() {
        if (!ws) { alert('未接続です'); return; }
        if (!state.isPlayer()) { alert('プレイヤーではありません'); return; }
        const out = { type: 'become_spectator' };
        if (state.getPlayerId()) out.player_id = state.getPlayerId();
        ws.sendObj(out);
        ui.setStatus('demoting...');
    }

    function handleStartGame() {
        if (!ws) { alert('未接続です'); return; }
        if (!state.isPlayer()) { alert('プレイヤーでないと開始できません'); return; }
        const out = { type: 'action', player_id: state.getPlayerId(), action: 'start', payload: {} };
        ws.sendObj(out);
        ui.disableStartButton();
    }

    function handleCanvasClick(coords) {
        if (!coords) return;
        const cid = renderer.cardAtPosition(coords.x, coords.y);
        if (cid < 0) return;
        if (renderer.owners[cid]) return;
        if (!state.isPlayer()) { alert('参加（プレイヤー）として参加してください'); return; }
        if (!state.hasStarted()) { alert('ゲームが開始されていません'); return; }
        try {
            const current = audioManager.getCurrentCardPos();
            if (current !== null && current === cid) {
                sendTakeAction(cid);
            } else {
                registerMistake();
            }
        } catch (err) {
            sendTakeAction(cid);
        }
    }

    function sendTakeAction(cardId) {
        if (!ws) return;
        const name = ui.getJoinFormState().name;
        const out = { type: 'action', player_id: state.getPlayerId(), action: 'take', payload: { id: cardId, player: name } };
        ws.sendObj(out);
    }

    function registerMistake() {
        if (typeof window._wrongClickPenalty === 'undefined') window._wrongClickPenalty = 0;
        window._wrongClickPenalty = (window._wrongClickPenalty || 0) + 1;
        if (ws && state.getPlayerId()) {
            ws.sendObj({ type: 'action', player_id: state.getPlayerId(), action: 'mistake', payload: {} });
        }
        try {
            if (window._errAudio === undefined) window._errAudio = new Audio('./dat/wav/error.wav');
            if (window._errAudio) {
                window._errAudio.currentTime = 0;
                window._errAudio.play().catch(() => { });
            }
        } catch (err) { }
    }

    function sendChatMessage(text) {
        if (!ws) return;
        const out = { type: 'chat', room_id: state.getRoomId(), payload: { message: text } };
        if (state.getPlayerId()) out.player_id = state.getPlayerId();
        if (state.getSpectatorId()) out.spectator_id = state.getSpectatorId();
        ws.sendObj(out);
    }

    function scheduleSequenceStart(seq, playAt) {
        const snapshot = state.getPendingSnapshot();
        const resumeIndex = snapshot && snapshot.started ? Number(snapshot.play_idx) || 0 : 0;
        const shouldResume = resumeIndex > 0;
        const startPlayback = () => {
            if (seq) {
                const startIdx = shouldResume ? resumeIndex : 0;
                audioManager.startSequenceFromServer(seq, startIdx);
            } else {
                audioManager.startSequence(renderer.cardLetters, renderer.owners);
            }
        };
        try {
            if (playAt) {
                const srv = Date.parse(playAt);
                if (!Number.isNaN(srv)) {
                    const localStart = srv - state.getServerOffset();
                    const delay = localStart - Date.now();
                    if (delay > 50) {
                        setTimeout(() => { try { startPlayback(); } catch (err) { console.warn('audio start fail', err); } }, delay);
                        return;
                    }
                }
            }
        } catch (err) {
            console.warn('scheduleSequenceStart failed', err);
        }
        startPlayback();
    }

    async function fetchMissingEvents(roomId, sinceId) {
        if (!roomId) return;
        try {
            let base = '';
            const wsUrl = ui.getWsUrlOrDefault('');
            if (wsUrl.startsWith('wss://')) base = 'https://' + wsUrl.substring(6).split('/')[0];
            else if (wsUrl.startsWith('ws://')) base = 'http://' + wsUrl.substring(5).split('/')[0];
            const fetchUrl = (base ? base : '') + '/rooms/' + encodeURIComponent(roomId) + '/events?since_id=' + encodeURIComponent(sinceId || 0);
            const resp = await fetch(fetchUrl);
            if (!resp.ok) return;
            const body = await resp.json();
            if (!body || !Array.isArray(body.events)) return;
            for (const ev of body.events) {
                try { handleMessage(ev); } catch (err) { console.warn('event replay failed', err); }
            }
        } catch (err) {
            console.warn('fetchMissingEvents failed', err);
        }
    }

    function sendPlayAck(index) {
        if (!ws) return;
        const token = state.getPlayerId() || state.getSpectatorId() || null;
        ws.sendObj({ type: 'play_ack', player_id: token, index });
    }
});
