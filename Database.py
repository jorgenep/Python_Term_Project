import sqlite3
import threading
import queue
import time
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tracking.db")

# --- Background write queue
_write_queue = queue.Queue()
_db_thread = None


_SCHEMA = """
          CREATE TABLE IF NOT EXISTS events (
                                                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                                                timestamp      REAL    NOT NULL,          -- Unix epoch (float)
                                                day            TEXT    NOT NULL,
                                                direction      TEXT    NOT NULL,          -- 'entry' or 'exit'
                                                object_id      INTEGER,                   -- tracker ID that crossed
                                                occupancy      INTEGER NOT NULL           -- occupancy AFTER this event
          );

          CREATE TABLE IF NOT EXISTS snapshots (
                                                   id             INTEGER PRIMARY KEY AUTOINCREMENT,
                                                   timestamp      REAL    NOT NULL,
                                                   occupancy      INTEGER NOT NULL,
                                                   process_ram_mb REAL,
                                                   sys_ram_mb     REAL,
                                                   fps            REAL
          );

          CREATE TABLE IF NOT EXISTS resets (
                                                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                                                timestamp      REAL    NOT NULL,
                                                previous_count INTEGER NOT NULL,
                                                note           TEXT
          ); \
          """



def init():
    """Create DB file + tables if they don't exist. Call once at startup."""
    con = sqlite3.connect(DB_PATH)
    con.executescript(_SCHEMA)
    con.commit()
    con.close()
    print(f"[DB] Initialized → {DB_PATH}")
    _start_writer()


#loop for the writer
def _writer_loop():
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    while True:
        try:
            task = _write_queue.get(timeout=5)
            if task is None:  # shutdown
                break
            sql, params = task
            con.execute(sql, params)
            con.commit()
        except queue.Empty:
            continue
        except Exception as e:
            print(f"[DB] Write error: {e}")
    con.close()


def _start_writer():
    global _db_thread
    _db_thread = threading.Thread(target=_writer_loop, daemon=True)
    _db_thread.start()


def _enqueue(sql, params=()):
    _write_queue.put((sql, params))


#helpers for write
def log_event(direction: str, object_id: int, occupancy: int):
    """Log a single entry or exit crossing."""
    _enqueue(
        "INSERT INTO events (timestamp, direction, object_id, occupancy) VALUES (?,?,?,?)",
        (time.time(),time.strftime("%Y-%m-%d"), direction, object_id, occupancy)
    )


def log_snapshot(occupancy: int, process_ram_mb: float, sys_ram_mb: float, fps: float):
    #60 second frame snapshot
    _enqueue(
        "INSERT INTO snapshots (timestamp, occupancy, process_ram_mb, sys_ram_mb, fps) VALUES (?,?,?,?,?)",
        (time.time(), occupancy, process_ram_mb, sys_ram_mb, fps)
    )


def log_reset(previous_count: int, note: str = "manual reset"):
   #reset occupancy counter
    _enqueue(
        "INSERT INTO resets (timestamp, previous_count, note) VALUES (?,?,?)",
        (time.time(), previous_count, note)
    )


#read helpers from flask
def _con():
    """Read-only connection. WAL mode allows this while writer is active."""
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row  # rows behave like dicts
    return con


def get_latest_occupancy() -> int:
    with _con() as con:
        row = con.execute(
            "SELECT occupancy FROM events ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return row["occupancy"] if row else 0


def get_recent_events(limit: int = 50) -> list:
    with _con() as con:
        rows = con.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_recent_snapshots(limit: int = 100) -> list:
    with _con() as con:
        rows = con.execute(
            "SELECT * FROM snapshots ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_daily_summary() -> list:
    #in and out by day
    with _con() as con:
        rows = con.execute("""
                           SELECT
                               date(timestamp, 'unixepoch', 'localtime') AS day,
                               SUM(CASE WHEN direction='entry' THEN 1 ELSE 0 END) AS entries,
                               SUM(CASE WHEN direction='exit'  THEN 1 ELSE 0 END) AS exits
                           FROM events
                           GROUP BY day
                           ORDER BY day DESC
                           """).fetchall()
        return [dict(r) for r in rows]


def get_daily_peak_occupancy() -> list:
    #max room population by day
    with _con() as con:
        rows = con.execute("""
            SELECT
                day,
                MAX(occupancy) AS peak_occupancy
            FROM events
            GROUP BY day
            ORDER BY day DESC
        """).fetchall()
        return [dict(r) for r in rows]


def get_daily_avg_occupancy() -> list:
    #average population by day
    with _con() as con:
        rows = con.execute("""
            SELECT
                day,
                ROUND(AVG(occupancy), 2) AS avg_occupancy
            FROM events
            GROUP BY day
            ORDER BY day DESC
        """).fetchall()
        return [dict(r) for r in rows]


def shutdown():
    #destroy rest of writes before exiting
    _write_queue.put(None)
    if _db_thread:
        _db_thread.join(timeout=5)