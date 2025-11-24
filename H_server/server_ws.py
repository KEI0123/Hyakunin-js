"""
WebSocket ベースのプロトタイプサーバー

このモジュールは FastAPI を用いて WebSocket 接続を受け付け、ルーム単位での
イベントブロードキャストを行います。既存の HTTP ベースのイベントモデルと同様に
イベントを `events` リストで管理し、接続クライアントには JSON メッセージを送受信します。

クライアントとの基本メッセージフォーマット（JSON）:
 - クライアント -> サーバー
   - join: {"type":"join","room_id":null|str,"role":"player"|"spectator","name":"..."}
   - action: {"type":"action","player_id":"..","action":"take","payload":{...}}
   - leave: {"type":"leave","role":"player"|"spectator","id":"..."}
 - サーバー -> クライアント（ブロードキャスト）
   - events は既存と同様の形式（"player_joined", "player_action", ...）を送る

簡易実装であり、永続化や認証、スケーリングは行っていません。将来的には Redis
などを用いた pub/sub に置き換えてスケールさせる想定です。
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
import asyncio
import secrets
import string
import datetime
from typing import Dict, Any, Set, Optional
import random
import logging

app = FastAPI()

# simple logger for the module
logger = logging.getLogger("server_ws")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)


# rooms: room_id -> dict
# each room: { "room_id": str, "players": [ {player_id,name,slot,...} ],
#              "spectators": [...], "events": [...], "next_event_id": int,
#              "connections": set(WebSocket), "lock": asyncio.Lock() }
rooms: Dict[str, Dict[str, Any]] = {}

MAX_EVENTS_PER_ROOM = 1000

def utcnow_iso() -> str:
        """
        現在時刻を ISO8601 (UTC, 終端に 'Z') 形式で返す。

        - タイムゾーン情報を含む UTC 時刻を生成して、既存クライアントとの互換性のため
            末尾を 'Z' に置換します。
        - 将来的な互換性のため、`utcnow()` の単純利用は避けています。
        """
        dt = datetime.datetime.now(datetime.timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")

    # ---------------------------------------------------------------------------
    # ヘルパ関数
    # サーバー内部で使用する小さなユーティリティ関数群です。
    # 変更する場合は挙動に注意してください（特に時刻形式など）。
    # ---------------------------------------------------------------------------

def gen_id(n: int = 6) -> str:
    """
    ランダムな英数字からなる識別子を生成するヘルパ。

    デフォルト長は 6 文字。暗号学的に安全な `secrets.choice` を利用します。
    """
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(n))


def find_player(room: Dict[str, Any], player_id: str) -> Optional[Dict[str, Any]]:
    # room の players リストから player_id に一致するプレイヤー辞書を返す
    # 見つからなければ None を返却する
    for p in room.get("players", []):
        if p.get("player_id") == player_id:
            return p
    return None


def find_spectator(room: Dict[str, Any], spectator_id: str) -> Optional[Dict[str, Any]]:
    # room の spectators リストから spectator_id に一致する観戦者を返す
    for s in room.get("spectators", []):
        if s.get("spectator_id") == spectator_id:
            return s
    return None

def make_room(max_players: int = 2) -> Dict[str, Any]:
    """
    新しいルームを作成して `rooms` に登録して返す。

    - `room_id` は他のルームと重複しないように生成します。
    - カードは 0..99 からランダムに 10 個選びます（ゲームロジック用）。
    """
    room_id = None
    while True:
        candidate = gen_id(6)
        if candidate not in rooms:
            room_id = candidate
            break
    now = utcnow_iso()
    # このルーム用に 0..99 の中から 10 個のカード ID をランダムに選ぶ
    card_letters = random.sample(list(range(100)), 10)

    # 新しいルーム状態を初期化して返す
    room = {
        "room_id": room_id,
        "created_at": now,
        "players": [],
        "spectators": [],
        # owners: 10 枚のカードそれぞれの所有者名（未所有は空文字）
        "owners": ["" for _ in range(10)],
        # card_letters: 各カードに対応する数値 ID
        "card_letters": card_letters,
        # penalties: player_name -> penalty count (mistakes)
        "penalties": {},
        # play_sequence: list of { "cardPos": int|null, "letter": int }
        "play_sequence": [],
        # whether a game in this room has been started
        "started": False,
        "events": [],
        "next_event_id": 1,
        "meta": {"max_players": max_players},
        "connections": set(),
        "lock": asyncio.Lock(),
    }
    rooms[room_id] = room
    return room


def create_room_with_id(room_id: str, max_players: int = 2) -> Dict[str, Any]:
    """
    Create a room with a fixed room_id if not existing. Used to pre-create named rooms like room01..room10.
    """
    if room_id in rooms:
        return rooms[room_id]
    now = utcnow_iso()
    card_letters = random.sample(list(range(100)), 10)
    # 指定の room_id を使ってルームを作る（存在すれば既存のものを返す）
    room = {
        "room_id": room_id,
        "created_at": now,
        "players": [],
        "spectators": [],
        "owners": ["" for _ in range(10)],
        "card_letters": card_letters,
        "penalties": {},
        "play_sequence": [],
        "started": False,
        "events": [],
        "next_event_id": 1,
        "meta": {"max_players": max_players},
        "connections": set(),
        "lock": asyncio.Lock(),
    }
    rooms[room_id] = room
    return room


def ensure_fixed_rooms(prefix: str = 'room', count: int = 10):
    """
    Ensure fixed rooms like room01..room10 exist at startup.
    """
    for i in range(1, count + 1):
        rid = f"{prefix}{i:02d}"
        create_room_with_id(rid)


# Create fixed rooms at module import so they are always available
ensure_fixed_rooms('room', 10)

def add_event(room: Dict[str, Any], etype: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    指定ルームにイベントを追加して、そのイベントオブジェクトを返す。

    - `events` は最大長 `MAX_EVENTS_PER_ROOM` を超えたら古いイベントを切り捨てます。
    - 返却されるイベントには `id`, `type`, `payload`, `ts` が含まれます。
    """
    eid = room["next_event_id"]
    evt = {"id": eid, "type": etype, "payload": payload, "ts": utcnow_iso()}
    room["events"].append(evt)
    room["next_event_id"] += 1
    if len(room["events"]) > MAX_EVENTS_PER_ROOM:
        drop = len(room["events"]) - MAX_EVENTS_PER_ROOM
        room["events"] = room["events"][drop:]
    return evt

# ---------------------------------------------------------------------------
# ブロードキャスト／WebSocket 処理
# ここから下はクライアントとの接続受け取り、メッセージ処理、
# ルーム単位のブロードキャストを行う主要なロジックです。
# ---------------------------------------------------------------------------

async def broadcast(room: Dict[str, Any], message: Dict[str, Any]):
    """
    ルーム内のすべての接続に JSON メッセージをブロードキャストする。

    - 送信に失敗した接続は切断済みと判断してルームの接続集合から削除します。
    - 実際の送信は await されるため呼び出し側は非同期コンテキストで呼んでください。
    """
    conns: Set[WebSocket] = set(room.get("connections", set()))
    to_remove = []
    for ws in conns:
        try:
            await ws.send_json(message)
        except Exception as e:
            # 送信失敗（接続切断等）とみなし、後で集合から削除する
            logger.debug("broadcast: failed to send to websocket: %s", e)
            to_remove.append(ws)
            try:
                await ws.close()
            except Exception:
                pass
    if to_remove:
        async with room["lock"]:
            for ws in to_remove:
                room["connections"].discard(ws)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    room = None
    client_meta = {}
    pass_evt = None
    try:
        # 最初にクライアントからの join メッセージを待つ
        # 仕様: {"type": "join", "room_id": null|str, "role": "player"|"spectator", "name": "..."}
        msg = await websocket.receive_json()
        if not isinstance(msg, dict) or msg.get("type") != "join":
            await websocket.send_json({"type": "error", "error": "first message must be join"})
            await websocket.close()
            return

        room_id = msg.get("room_id")
        # default to spectator if role not provided; default name to anonymous
        role = msg.get("role") or "spectator"
        name = msg.get("name") or "(anonymous)"

        # ルームが存在しなければ作成、存在すれば取得
        if not room_id:
            room = make_room()
        else:
            room = rooms.get(room_id)
            if room is None:
                await websocket.send_json({"type": "error", "error": "room not found"})
                await websocket.close()
                return

        async with room["lock"]:
            # 接続を登録
            room["connections"].add(websocket)
            if role == "player":
                # プレイヤーとして参加。満員なら拒否
                if len(room["players"]) >= room["meta"].get("max_players", 2):
                    await websocket.send_json({"type": "error", "error": "room full"})
                    room["connections"].discard(websocket)
                    await websocket.close()
                    return
                player_id = secrets.token_urlsafe(8)
                used_slots = {p.get("slot") for p in room.get("players", []) if p.get("slot") is not None}
                slot = 0
                while slot in used_slots:
                    slot += 1
                p = {"player_id": player_id, "name": name, "joined_at": utcnow_iso(), "slot": slot}
                room["players"].append(p)
                evt = add_event(room, "player_joined", {"player_id": player_id, "name": name, "slot": slot})
                client_meta = {"role": "player", "player_id": player_id, "name": name}
            else:
                # 観覧者として参加
                spectator_id = secrets.token_urlsafe(8)
                s = {"spectator_id": spectator_id, "name": name, "joined_at": utcnow_iso()}
                room["spectators"].append(s)
                evt = add_event(room, "spectator_joined", {"spectator_id": spectator_id, "name": name})
                client_meta = {"role": "spectator", "spectator_id": spectator_id, "name": name}

        # スナップショットと参加確認を送信
        snapshot = {
            "type": "snapshot",
            "room": {
                "room_id": room["room_id"],
                "players": room["players"],
                "spectators": room["spectators"],
                "owners": room.get("owners", []),
                "card_letters": room.get("card_letters", []),
                "play_sequence": room.get("play_sequence", []),
                "started": room.get("started", False),
            },
            "next_event_id": room["next_event_id"],
        }
        await websocket.send_json({"type": "joined", "room_id": room["room_id"], "you": client_meta})
        await websocket.send_json(snapshot)

        # 参加イベントをブロードキャスト
        await broadcast(room, {"type": evt["type"], "id": evt["id"], "payload": evt["payload"]})

        # メイン受信ループ: クライアントからの action/chat/leave を処理
        while True:
            data = await websocket.receive_json()
            if not isinstance(data, dict):
                continue
            t = data.get("type")
            if t == "action":
                # プレイヤーの操作を処理
                player_id = data.get("player_id")
                action = data.get("action")
                payload = data.get("payload", {})
                async with room["lock"]:
                    found = find_player(room, player_id)
                    if not found:
                        await websocket.send_json({"type": "error", "error": "player not in room or invalid id"})
                        continue
                    # 特殊アクション: take（カード取得）
                    if action == "take":
                        cid = payload.get("id")
                        if not isinstance(cid, int) or cid < 0 or cid >= len(room.get("owners", [])):
                            await websocket.send_json({"type": "error", "error": "invalid card id"})
                            continue
                        player_name = payload.get("player") or found.get("name")
                        if room["owners"][cid]:
                            await websocket.send_json({"type": "error", "error": "card already taken"})
                            continue
                        room["owners"][cid] = player_name
                        evt = add_event(room, "player_action", {"player_id": player_id, "action": action, "payload": {"id": cid, "player": player_name}})
                        # After taking, check if enough cards are taken -> finish game
                        taken_count = sum(1 for o in room.get("owners", []) if o)
                        # finish when 9 or more cards have been taken (ユーザ要求)
                        if taken_count >= 9:
                            # count cards per player name
                            counts = {}
                            for o in room.get("owners", []):
                                if o:
                                    counts[o] = counts.get(o, 0) + 1
                            # apply penalties (subtract mistakes) recorded in room['penalties']
                            penalties = room.get("penalties", {}) or {}
                            for pname, pen in penalties.items():
                                if pname in counts:
                                    counts[pname] = max(0, counts.get(pname, 0) - int(pen))
                            # determine winner(s)
                            max_count = 0
                            winners = []
                            for name, cnt in counts.items():
                                if cnt > max_count:
                                    max_count = cnt
                                    winners = [name]
                                elif cnt == max_count:
                                    winners.append(name)
                            # choose label A/B by player slot if possible
                            winner_label = None
                            winner_name = None
                            if len(winners) == 1:
                                winner_name = winners[0]
                                # find player with that name to get slot
                                for p in room.get("players", []):
                                    if p.get("name") == winner_name:
                                        slot = p.get("slot")
                                        if slot is not None:
                                            # map 0 -> A, 1 -> B, others -> ?
                                            winner_label = chr(ord('A') + int(slot)) if isinstance(slot, int) and slot >= 0 else None
                                        break
                            else:
                                # tie
                                winner_name = None
                            # mark game as not started (finished)
                            room["started"] = False
                            payload_fin = {"winner": winner_name, "winner_label": winner_label, "counts": counts}
                            fin_evt = add_event(room, "game_finished", payload_fin)
                    elif action == "mistake":
                        # Player clicked wrong card (penalty)
                        player_name = found.get("name")
                        # increment penalty counter for this player name
                        cur = room.get("penalties", {}) or {}
                        cur[player_name] = cur.get(player_name, 0) + 1
                        room["penalties"] = cur
                        evt = add_event(room, "player_penalty", {"player_id": player_id, "player": player_name, "penalties": cur[player_name]})
                    elif action == "start":
                        # Start a new game in the room: reset owners and deal new card letters
                        # Only allow if sender is a valid player (checked above)
                        player_name = found.get("name")
                        # reset ownership and deal new card letters
                        room["owners"] = ["" for _ in range(10)]
                        room["card_letters"] = random.sample(list(range(100)), 10)
                        # build a play sequence: include the 10 table cards (with positions) and 9 random off-table letters
                        table_letters = room["card_letters"]
                        seq = []
                        present = set([int(x) for x in table_letters])
                        for i, lt in enumerate(table_letters):
                            seq.append({"cardPos": i, "letter": int(lt)})
                        pool = [v for v in range(100) if v not in present]
                        random.shuffle(pool)
                        extra = pool[:9]
                        for v in extra:
                            seq.append({"cardPos": None, "letter": int(v)})
                        random.shuffle(seq)
                        room["play_sequence"] = seq
                        # reset penalties at start of new game
                        room["penalties"] = {}
                        room["started"] = True
                        evt = add_event(room, "game_started", {"player_id": player_id, "player": player_name, "play_sequence": room.get("play_sequence", [])})
                        # prepare snapshot to broadcast
                        snapshot = {
                            "type": "snapshot",
                            "room": {
                                "room_id": room["room_id"],
                                "players": room["players"],
                                "spectators": room["spectators"],
                                "owners": room.get("owners", []),
                                "card_letters": room.get("card_letters", []),
                                "play_sequence": room.get("play_sequence", []),
                                "started": room.get("started", False),
                            },
                            "next_event_id": room["next_event_id"],
                        }
                    else:
                        evt = add_event(room, "player_action", {"player_id": player_id, "action": action, "payload": payload})
                # broadcast event
                await broadcast(room, {"type": evt["type"], "id": evt["id"], "payload": evt["payload"]})
                # if finish event was created, broadcast it
                try:
                    if 'fin_evt' in locals():
                        await broadcast(room, {"type": fin_evt["type"], "id": fin_evt["id"], "payload": fin_evt["payload"]})
                except Exception:
                    pass
                # if start, broadcast snapshot as well
                if action == "start":
                    await broadcast(room, snapshot)
            elif t == "become_player":
                # spectator -> player 昇格リクエスト
                # クライアント側は通常ボタン押下でこのメッセージを送る
                async with room["lock"]:
                    # identify spectator by client_meta first, fallback to provided id
                    sid = client_meta.get("spectator_id") or data.get("spectator_id")
                    if not sid:
                        await websocket.send_json({"type": "error", "error": "not a spectator or missing id"})
                        continue
                    # ensure spectator exists
                    spec = None
                    for s in room.get("spectators", []):
                        if s.get("spectator_id") == sid:
                            spec = s
                            break
                    if not spec:
                        await websocket.send_json({"type": "error", "error": "spectator not found"})
                        continue
                    # check room capacity
                    if len(room.get("players", [])) >= room["meta"].get("max_players", 2):
                        await websocket.send_json({"type": "error", "error": "room full"})
                        continue
                    # create player entry
                    player_id = secrets.token_urlsafe(8)
                    used_slots = {p.get("slot") for p in room.get("players", []) if p.get("slot") is not None}
                    slot = 0
                    while slot in used_slots:
                        slot += 1
                    pname = spec.get("name") or data.get("name") or "(anonymous)"
                    p = {"player_id": player_id, "name": pname, "joined_at": utcnow_iso(), "slot": slot}
                    room["players"].append(p)
                    # remove spectator
                    room["spectators"] = [x for x in room.get("spectators", []) if x.get("spectator_id") != sid]
                    # update client_meta
                    client_meta = {"role": "player", "player_id": player_id, "name": pname}
                    evt = add_event(room, "player_joined", {"player_id": player_id, "name": pname, "slot": slot})
                # notify the requester and broadcast
                await websocket.send_json({"type": "promoted", "you": client_meta})
                # optional: send updated snapshot to the promoted client
                await websocket.send_json({"type": "snapshot", "room": {"room_id": room["room_id"], "players": room["players"], "spectators": room["spectators"], "owners": room.get("owners", []), "card_letters": room.get("card_letters", [])}, "next_event_id": room["next_event_id"]})
                await broadcast(room, {"type": evt["type"], "id": evt["id"], "payload": evt["payload"]})
            elif t == "become_spectator":
                # player -> spectator 昇格（退席して観覧者になる）
                async with room["lock"]:
                    pid = client_meta.get("player_id") or data.get("player_id")
                    if not pid:
                        await websocket.send_json({"type": "error", "error": "not a player or missing id"})
                        continue
                    # find player
                    found = None
                    for p in room.get("players", []):
                        if p.get("player_id") == pid:
                            found = p
                            break
                    if not found:
                        await websocket.send_json({"type": "error", "error": "player not found"})
                        continue
                    pname = found.get("name")
                    # create spectator entry
                    spectator_id = secrets.token_urlsafe(8)
                    s = {"spectator_id": spectator_id, "name": pname, "joined_at": utcnow_iso()}
                    room["spectators"].append(s)
                    # remove player from players list
                    room["players"] = [p for p in room.get("players", []) if p.get("player_id") != pid]
                    # update client_meta
                    client_meta = {"role": "spectator", "spectator_id": spectator_id, "name": pname}
                    evt_left = add_event(room, "player_left", {"player_id": pid})
                    evt_spec = add_event(room, "spectator_joined", {"spectator_id": spectator_id, "name": pname})
                # notify requester and broadcast
                await websocket.send_json({"type": "demoted", "you": client_meta})
                await websocket.send_json({"type": "snapshot", "room": {"room_id": room["room_id"], "players": room["players"], "spectators": room["spectators"], "owners": room.get("owners", []), "card_letters": room.get("card_letters", [])}, "next_event_id": room["next_event_id"]})
                await broadcast(room, {"type": evt_left["type"], "id": evt_left["id"], "payload": evt_left["payload"]})
                await broadcast(room, {"type": evt_spec["type"], "id": evt_spec["id"], "payload": evt_spec["payload"]})
            elif t == "chat":
                # チャットメッセージ処理: payload に {"message": "..."} を期待
                payload = data.get("payload", {})
                msg_text = payload.get("message")
                if not isinstance(msg_text, str):
                    await websocket.send_json({"type": "error", "error": "invalid chat payload"})
                    continue
                sender_name = None
                async with room["lock"]:
                    pid = data.get("player_id")
                    if pid:
                        p = find_player(room, pid)
                        if p:
                            sender_name = p.get("name")
                    if sender_name is None:
                        sid = data.get("spectator_id")
                        if sid:
                            s = find_spectator(room, sid)
                            if s:
                                sender_name = s.get("name")
                    if sender_name is None:
                        sender_name = data.get("name") or "(anonymous)"
                    evt = add_event(room, "chat_message", {"from": sender_name, "message": msg_text})
                await broadcast(room, {"type": evt["type"], "id": evt["id"], "payload": evt["payload"]})
            elif t == "leave":
                # グレースフルな退室処理
                role = data.get("role")
                token = data.get("id") or data.get("player_id") or data.get("spectator_id")
                async with room["lock"]:
                    if role == "player":
                        before = len(room.get("players", []))
                        room["players"] = [p for p in room.get("players", []) if p.get("player_id") != token]
                        after = len(room.get("players", []))
                        if before != after:
                            evt = add_event(room, "player_left", {"player_id": token})
                            await broadcast(room, {"type": evt["type"], "id": evt["id"], "payload": evt["payload"]})
                    elif role == "spectator":
                        before = len(room.get("spectators", []))
                        room["spectators"] = [s for s in room.get("spectators", []) if s.get("spectator_id") != token]
                        after = len(room.get("spectators", []))
                        if before != after:
                            evt = add_event(room, "spectator_left", {"spectator_id": token})
                            await broadcast(room, {"type": evt["type"], "id": evt["id"], "payload": evt["payload"]})
                # 接続を閉じる
                break
            else:
                # 不明なメッセージタイプは無視ではなくエラーで通知する
                await websocket.send_json({"type": "error", "error": "unknown message type"})

    except WebSocketDisconnect:
        # treat disconnect as leave
        pass
    finally:
        # cleanup
        if room is not None:
            async with room["lock"]:
                if websocket in room["connections"]:
                    room["connections"].discard(websocket)
                # if was player/spectator, remove and broadcast left
                if client_meta.get("role") == "player":
                    pid = client_meta.get("player_id")
                    if pid:
                        # remove player and clear any ownerships held by this player name
                        pname = None
                        for p in room.get("players", []):
                            if p.get("player_id") == pid:
                                pname = p.get("name")
                                break
                        room["players"] = [p for p in room.get("players", []) if p.get("player_id") != pid]
                        if pname:
                            for i, o in enumerate(room.get("owners", [])):
                                if o == pname:
                                    room["owners"][i] = ""
                        evt = add_event(room, "player_left", {"player_id": pid})
                        pass_evt = evt
                elif client_meta.get("role") == "spectator":
                    sid = client_meta.get("spectator_id")
                    if sid:
                        room["spectators"] = [s for s in room.get("spectators", []) if s.get("spectator_id") != sid]
                        evt = add_event(room, "spectator_left", {"spectator_id": sid})
                        pass_evt = evt
            # broadcast any left event (do outside the lock to avoid reentrancy)
            try:
                if pass_evt:
                    await broadcast(room, {"type": pass_evt["type"], "id": pass_evt["id"], "payload": pass_evt["payload"]})
            except Exception:
                pass


@app.get("/rooms/{room_id}")
async def get_room(room_id: str):
    r = rooms.get(room_id)
    if not r:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return {
        "room_id": r["room_id"],
        "players": [{"player_id": p["player_id"], "name": p["name"], "slot": p.get("slot")} for p in r["players"]],
        "spectators": [{"spectator_id": s["spectator_id"], "name": s["name"]} for s in r["spectators"]],
        "owners": r.get("owners", []),
        "card_letters": r.get("card_letters", []),
        "play_sequence": r.get("play_sequence", []),
        "next_event_id": r["next_event_id"],
        "started": r.get("started", False),
    }


@app.get("/")
async def root():
    # Simple root for health checks / informational purpose
    return {"status": "ok", "message": "Hyakunin WebSocket server"}


@app.get("/health")
async def health():
    return JSONResponse(status_code=200, content={"status": "ok"})


@app.get("/favicon.ico")
async def favicon():
    # Return no content to avoid 404 noise from browsers/health checks
    return JSONResponse(status_code=204, content=None)


if __name__ == "__main__":
    # When deploying to platforms like Render, the port is provided via the
    # PORT environment variable. Use it if present, otherwise fall back to 5001
    # for local development.
    import uvicorn
    import os

    port = int(os.environ.get("PORT", "5001"))
    uvicorn.run(app, host="0.0.0.0", port=port)
