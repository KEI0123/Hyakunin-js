Server for Hyakunin (FastAPI WebSocket + HTTP endpoints)

Files:

- `server_ws.py` : FastAPI-based server implementing WebSocket `/ws` and HTTP room/events endpoints.
- `requirements.txt`: minimal dependencies.

Quick start (PowerShell):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python .\server_ws.py
```

Endpoints (summary):

- POST `/rooms` -> create room
- GET `/rooms` -> list rooms
- GET `/rooms/{room_id}` -> room state
- POST `/rooms/{room_id}/join` -> join as player or spectator
- POST `/rooms/{room_id}/leave` -> leave
- POST `/rooms/{room_id}/action` -> player action (validated)
- GET `/rooms/{room_id}/events?since_id=NNN&limit=XX` -> retrieve events

Notes:

- This is an in-memory implementation. Data is lost on restart.
- For concurrency safety we use a global lock; for higher scale consider per-room locks or Redis.
- To integrate with the existing C++ client, use `/rooms/{id}/action` for player actions and `/rooms/{id}/events` to obtain event updates.
