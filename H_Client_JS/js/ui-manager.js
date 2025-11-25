(function (global) {
    "use strict";

    class UIManager {
        constructor(options = {}) {
            const { lobbySize = 10 } = options;
            this.statusEl = document.getElementById('status');
            this.btnCreate = document.getElementById('btnCreate');
            this.btnBack = document.getElementById('btnBack');
            this.btnStart = document.getElementById('btnStart');
            this.btnBecome = document.getElementById('btnBecome');
            this.btnWithdraw = document.getElementById('btnWithdraw');
            this.inpName = document.getElementById('inpName');
            this.inpRoom = document.getElementById('inpRoom');
            this.inpWsUrl = document.getElementById('inpWsUrl');
            this.lobbyGrid = document.getElementById('lobbyGrid');
            this.lobbyView = document.getElementById('lobbyView');
            this.gameView = document.getElementById('gameView');
            this.canvas = document.getElementById('gameCanvas');
            this.handlers = Object.create(null);
            this.tileRoomIds = Array.from({ length: lobbySize }, (_, i) => {
                const n = i + 1;
                return 'room' + (n < 10 ? '0' + n : '' + n);
            });
            this.selectedTileIndex = null;
            this._renderLobbyTiles();
            this._bindEvents();
            if (this.btnBecome) this.btnBecome.disabled = true;
            if (this.btnWithdraw) this.btnWithdraw.disabled = true;
            if (this.btnStart) this.btnStart.style.display = 'none';
        }

        _bindEvents() {
            if (this.btnCreate) {
                this.btnCreate.addEventListener('click', () => {
                    this._emit('create', this.getJoinFormState());
                });
            }
            if (this.btnBack) {
                this.btnBack.addEventListener('click', () => this._emit('back'));
            }
            if (this.btnBecome) {
                this.btnBecome.addEventListener('click', () => this._emit('become'));
            }
            if (this.btnWithdraw) {
                this.btnWithdraw.addEventListener('click', () => this._emit('withdraw'));
            }
            if (this.btnStart) {
                this.btnStart.addEventListener('click', () => this._emit('start'));
            }
            if (this.canvas) {
                this.canvas.addEventListener('click', (ev) => {
                    const rect = this.canvas.getBoundingClientRect();
                    const coords = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
                    this._emit('canvas', coords);
                });
            }
        }

        _renderLobbyTiles() {
            if (!this.lobbyGrid) return;
            this.lobbyGrid.innerHTML = '';
            this.tileRoomIds.forEach((roomId, idx) => {
                const tile = document.createElement('div');
                tile.className = 'roomTile' + (roomId ? '' : ' empty');
                tile.dataset.index = idx;
                const title = document.createElement('div');
                title.className = 'title';
                title.textContent = roomId ? ('Room ' + roomId) : ('空き部屋 #' + (idx + 1));
                const sub = document.createElement('div');
                sub.className = 'sub';
                sub.textContent = roomId ? 'Click to join' : 'Click to create & join';
                tile.appendChild(title);
                tile.appendChild(sub);
                tile.addEventListener('click', () => this._handleTileClick(idx));
                this.lobbyGrid.appendChild(tile);
            });
        }

        _handleTileClick(index) {
            this.selectedTileIndex = index;
            const targetRoom = this.tileRoomIds[index] || '';
            this.setRoomInput(targetRoom);
            this._emit('lobbyTile', { index, roomId: targetRoom || null });
            this._emit('create', this.getJoinFormState());
        }

        on(eventName, handler) {
            this.handlers[eventName] = handler;
        }

        _emit(eventName, payload) {
            const handler = this.handlers[eventName];
            if (typeof handler === 'function') {
                handler(payload);
            }
        }

        getJoinFormState() {
            return {
                name: this.inpName ? this.inpName.value.trim() : '',
                room: this.inpRoom ? (this.inpRoom.value.trim() || null) : null,
                wsUrl: this.inpWsUrl ? this.inpWsUrl.value.trim() : '',
            };
        }

        setRoomInput(value) {
            if (this.inpRoom) this.inpRoom.value = value || '';
        }

        getWsUrlOrDefault(defaultUrl) {
            const configured = this.inpWsUrl ? this.inpWsUrl.value.trim() : '';
            if (configured) return configured;
            if (defaultUrl) return defaultUrl;
            return 'wss://hyakunin-js.onrender.com/ws';
        }

        setStatus(text) {
            if (this.statusEl) this.statusEl.textContent = text || '';
        }

        showGameView() {
            if (this.lobbyView) this.lobbyView.style.display = 'none';
            if (this.gameView) this.gameView.style.display = 'flex';
        }

        showLobbyView() {
            if (this.lobbyView) this.lobbyView.style.display = '';
            if (this.gameView) this.gameView.style.display = 'none';
        }

        updateRoleControls(role) {
            const isPlayer = role === 'player';
            if (this.btnBecome) this.btnBecome.disabled = isPlayer;
            if (this.btnWithdraw) this.btnWithdraw.disabled = !isPlayer;
            this.setStartVisibility(isPlayer);
        }

        setStartVisibility(show) {
            if (!this.btnStart) return;
            this.btnStart.style.display = show ? '' : 'none';
            this.btnStart.disabled = !show;
        }

        disableStartButton() {
            if (this.btnStart) this.btnStart.disabled = true;
        }

        markTileRoom(index, roomId) {
            if (index === null || index === undefined) return;
            if (index < 0 || index >= this.tileRoomIds.length) return;
            this.tileRoomIds[index] = roomId || null;
            this._renderLobbyTiles();
        }

        consumeSelectedTile() {
            const idx = this.selectedTileIndex;
            this.selectedTileIndex = null;
            return idx;
        }

        refreshLobbyTitles(roomIds) {
            if (Array.isArray(roomIds) && roomIds.length === this.tileRoomIds.length) {
                this.tileRoomIds = roomIds.slice();
                this._renderLobbyTiles();
            }
        }
    }

    global.UIManager = UIManager;
})(window);
