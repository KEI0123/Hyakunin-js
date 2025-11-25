(function (global) {
    "use strict";

    function createServerMessageHandler(deps = {}) {
        const {
            state,
            ui,
            renderer,
            chat,
            audioManager,
            fetchMissingEvents,
            scheduleSequenceStart,
        } = deps;

        if (!state || !ui || !renderer || !chat || !audioManager || !scheduleSequenceStart) {
            throw new Error('Missing dependencies for message handler');
        }

        function updateRoomInfo() {
            if (chat && typeof chat.setRoomInfo === 'function') {
                chat.setRoomInfo(state.getRoomId(), state.getPlayers(), state.getSpectators(), '');
            }
        }

        function handleJoined(msg) {
            state.resetEventHistory();
            state.setRoomId(msg.room_id || '');
            state.applyIdentity(msg.you || {});
            state.setStarted(false);
            state.setPendingSnapshot(null);
            if (chat && typeof chat.clearMessages === 'function') chat.clearMessages();
            chat.pushMessage('', 'joined: ' + state.getRoomId());
            const selected = ui.consumeSelectedTile();
            if (selected !== null && selected !== undefined) {
                ui.markTileRoom(selected, state.getRoomId());
            }
            ui.showGameView();
            if (renderer && typeof renderer.resize === 'function') {
                try { renderer.resize(); } catch (err) { }
            }
            ui.updateRoleControls(state.getRole());
            ui.setStatus('joined ' + state.getRoomId() + ' as ' + state.getRole());
            audioManager.stop();
        }

        function handleSnapshot(msg) {
            const room = msg.room || {};
            const snapshot = {
                owners: room.owners || [],
                card_letters: room.card_letters || [],
                play_sequence: room.play_sequence || null,
                play_at: room.play_at || null,
                play_idx: typeof room.play_idx !== 'undefined' ? room.play_idx : 0,
                room_id: room.room_id || state.getRoomId(),
                started: !!room.started,
            };
            state.setPendingSnapshot(snapshot);
            state.setStarted(!!room.started);
            state.updateLastSeenFromSnapshot(msg.next_event_id);
            state.setPlayers(room.players || []);
            state.setSpectators(room.spectators || []);
            updateRoomInfo();
            if (typeof fetchMissingEvents === 'function' && snapshot.room_id) {
                const sinceId = Math.max(0, state.getLastSeenEventId() - 1);
                fetchMissingEvents(snapshot.room_id, sinceId);
            }
            if (state.hasStarted()) {
                renderer.setState(snapshot.owners, snapshot.card_letters);
                const seq = snapshot.play_sequence;
                if (state.isPlayer()) {
                    scheduleSequenceStart(seq, snapshot.play_at);
                } else if (Array.isArray(seq)) {
                    audioManager.primeSequence(seq, snapshot.play_idx || 0);
                }
            }
        }

        function handlePlayerAction(msg) {
            const payload = msg.payload || {};
            if (payload.action === 'take') {
                const cid = payload.payload && payload.payload.id;
                const playerName = payload.payload && payload.payload.player;
                if (typeof cid === 'number') {
                    const owners = renderer.owners.slice();
                    owners[cid] = playerName || owners[cid];
                    renderer.setState(owners, renderer.cardLetters);
                    try { audioManager.onCardTaken(cid); } catch (err) { }
                    chat.pushMessage('', (playerName || '') + ' took ' + cid);
                }
                return;
            }
            if (payload.action === 'start') {
                state.setStarted(true);
                const pending = state.getPendingSnapshot();
                if (pending) {
                    renderer.setState(pending.owners || [], pending.card_letters || []);
                }
                ui.setStartVisibility(false);
                const seq = (pending && pending.play_sequence) || (payload.payload && payload.payload.play_sequence) || null;
                const playAt = (pending && pending.play_at) || (payload.payload && payload.payload.play_at) || null;
                scheduleSequenceStart(seq, playAt);
            }
        }

        function handleGameStarted(msg) {
            const payload = msg.payload || {};
            chat.pushMessage('system', (payload.player || 'Someone') + ' started the game');
            state.setStarted(true);
            const pending = state.getPendingSnapshot();
            if (pending) renderer.setState(pending.owners || [], pending.card_letters || []);
            ui.setStartVisibility(false);
            const seq = (payload && payload.play_sequence) || (pending && pending.play_sequence) || null;
            const playAt = payload && payload.play_at ? payload.play_at : (pending && pending.play_at ? pending.play_at : null);
            scheduleSequenceStart(seq, playAt);
        }

        function handleGameFinished(msg) {
            const payload = msg.payload || {};
            if (payload.winner) {
                chat.pushMessage('system', 'winner ' + payload.winner);
                renderer.setOverlay('Winner: ' + payload.winner, 6000);
            } else if (payload.winner_label) {
                chat.pushMessage('system', 'winner ' + payload.winner_label);
                renderer.setOverlay('Winner: ' + payload.winner_label, 6000);
            } else {
                chat.pushMessage('system', 'draw');
                renderer.setOverlay('Draw', 6000);
            }
            state.setStarted(false);
            try { audioManager.stop(); } catch (err) { }
            if (payload.counts) {
                Object.entries(payload.counts).forEach(([name, cnt]) => {
                    chat.pushMessage('system', name + ': ' + cnt);
                });
            }
        }

        function handlePromotion(msg) {
            const you = msg.you || {};
            if (you.player_id) state.setPlayerId(you.player_id);
            if (you.spectator_id) state.setSpectatorId(you.spectator_id);
            state.setRole(you.player_id ? 'player' : (you.spectator_id ? 'spectator' : state.getRole()));
            ui.updateRoleControls(state.getRole());
            ui.setStatus('joined ' + state.getRoomId() + ' as ' + state.getRole());
        }

        function handleDemotion(msg) {
            const you = msg.you || {};
            if (you.spectator_id) state.setSpectatorId(you.spectator_id);
            if (you.player_id) state.setPlayerId(you.player_id);
            state.setRole(you.spectator_id ? 'spectator' : state.getRole());
            ui.updateRoleControls(state.getRole());
            ui.setStatus('joined ' + state.getRoomId() + ' as ' + state.getRole());
        }

        function handleLeft(msg) {
            const payload = msg.payload || {};
            if (state.tryResolveLeave(msg.type, payload)) {
                return;
            }
            if (msg.type === 'player_left') {
                state.removePlayer(payload.player_id);
                chat.pushMessage('', (payload.player_id || '') + ' left');
            } else {
                state.removeSpectator(payload.spectator_id);
                chat.pushMessage('', (payload.spectator_id || '') + ' left');
            }
            updateRoomInfo();
        }

        function handleJoins(msg) {
            const payload = msg.payload || {};
            if (msg.type === 'player_joined') {
                state.addPlayer(payload.player_id, payload.name);
                chat.pushMessage('', (payload.name || '(unknown)') + ' joined');
            } else {
                state.addSpectator(payload.spectator_id, payload.name);
                chat.pushMessage('', (payload.name || '(unknown)') + ' joined (spectator)');
            }
            updateRoomInfo();
        }

        return function handleMessage(msg) {
            if (!msg || typeof msg !== 'object') return;
            if (msg.server_ts) state.updateServerOffset(msg.server_ts);
            if (!state.markEventProcessed(msg.id)) return;
            switch (msg.type) {
                case 'joined':
                    handleJoined(msg);
                    break;
                case 'snapshot':
                    handleSnapshot(msg);
                    break;
                case 'player_action':
                    handlePlayerAction(msg);
                    break;
                case 'player_joined':
                case 'spectator_joined':
                    handleJoins(msg);
                    break;
                case 'player_penalty': {
                    const payload = msg.payload || {};
                    chat.pushMessage('system', `${payload.player || '(unknown)'} お手つき -1 (total: ${payload.penalties || 0})`);
                    break;
                }
                case 'player_left':
                case 'spectator_left':
                    handleLeft(msg);
                    break;
                case 'promoted':
                    handlePromotion(msg);
                    break;
                case 'chat_message': {
                    const payload = msg.payload || {};
                    chat.pushMessage(payload.from || '', payload.message || '');
                    break;
                }
                case 'game_started':
                    handleGameStarted(msg);
                    break;
                case 'game_finished':
                    handleGameFinished(msg);
                    break;
                case 'demoted':
                    handleDemotion(msg);
                    break;
                case 'error':
                    chat.pushMessage('server', 'error: ' + (msg.error || 'unknown'));
                    break;
                case 'play_continue':
                    try { audioManager.onPlayContinue(msg.index); } catch (err) { }
                    break;
                case 'play_item': {
                    try {
                        audioManager.playFromIndex(msg.index);
                    } catch (err) { }
                    break;
                }
                default: {
                    const room = msg.room;
                    if (room && (room.owners || room.card_letters)) {
                        const pending = {
                            owners: room.owners || [],
                            card_letters: room.card_letters || [],
                        };
                        state.setPendingSnapshot(pending);
                        if (state.hasStarted()) renderer.setState(pending.owners, pending.card_letters);
                    }
                    break;
                }
            }
        };
    }

    global.createServerMessageHandler = createServerMessageHandler;
})(window);
