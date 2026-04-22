import os
import sys
import platform
import threading
import webbrowser
import psutil
import db

db.init()

# --- PLATFORM DETECTION ---
IS_WINDOWS = sys.platform == 'win32'
IS_LINUX   = sys.platform.startswith('linux')
IS_RPI     = IS_LINUX and platform.machine() in ('armv7l', 'aarch64')

print(f"[INFO] Platform: {'Windows' if IS_WINDOWS else ('RPi4/ARM' if IS_RPI else 'Linux x86-64')}")

try:
    from flask import Flask, Response
except ImportError:
    sys.exit("[ERROR] Flask is required.  Run:  pip install flask")

import cv2
import numpy as np
import time
from scipy.optimize import linear_sum_assignment

# --- MJPEG STREAM SERVER (replaces cv2.imshow — works on all platforms) ---
_flask_app    = Flask(__name__)
_frame_lock   = threading.Lock()
_frame_event  = threading.Event()  # signals that a new frame is ready
_latest_frame = None               # bytes: JPEG-encoded frame

_HTML_PAGE = """
<!doctype html><html><head>
<title>Phase 3 — Live Count</title>
<style>
  body  { background:#111; display:flex; flex-direction:column;
          align-items:center; justify-content:center; height:100vh; margin:0; }
  img   { max-width:100%; border:2px solid #0f0; }
  h2    { color:#0f0; font-family:monospace; margin-bottom:8px; }
</style></head><body>
<h2>Phase 3 — Live Person Count</h2>
<img src="/video_feed" alt="stream">
</body></html>
"""

@_flask_app.route('/')
def _index():
    return _HTML_PAGE

def _generate():
    """Block until a new frame is ready, then yield it once.
    This prevents flooding the browser and avoids memory build-up."""
    last_frame = None
    while True:
        # Block here (up to 2 s) instead of busy-spinning
        _frame_event.wait(timeout=2.0)
        _frame_event.clear()
        with _frame_lock:
            frame = _latest_frame
        if frame is None or frame is last_frame:
            continue
        last_frame = frame
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')

@_flask_app.route('/video_feed')
def _video_feed():
    return Response(_generate(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

def _start_server(port=8080):
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)   # silence Flask request logs
    _flask_app.run(host='0.0.0.0', port=port, threaded=True)

# --- TFLite RUNTIME (cross-platform import) ---
# RPi4 / ARM Linux : pip install tflite-runtime
# x86-64 Linux     : pip install ai-edge-litert
# Windows x86-64   : pip install ai-edge-litert
try:
    from ai_edge_litert.interpreter import Interpreter
    print("[INFO] TFLite backend: ai-edge-litert")
except ImportError:
    try:
        from tflite_runtime.interpreter import Interpreter
        print("[INFO] TFLite backend: tflite-runtime")
    except ImportError:
        sys.exit(
            "[ERROR] No TFLite runtime installed.\n"
            "  RPi4 / ARM : pip install tflite-runtime\n"
            "  x86-64     : pip install ai-edge-litert"
        )

from flask import jsonify, request

@_flask_app.route('/api/count')
def api_count():
    return jsonify({"occupancy": total_count})

@_flask_app.route('/api/events')
def api_events():
    limit = int(request.args.get('limit', 50))
    return jsonify(db.get_recent_events(limit))

@_flask_app.route('/api/snapshots')
def api_snapshots():
    return jsonify(db.get_recent_snapshots())

@_flask_app.route('/api/summary')
def api_summary():
    return jsonify(db.get_daily_summary())

@_flask_app.route('/api/reset', methods=['POST'])
def api_reset():
    global total_count
    db.log_reset(previous_count=total_count)
    total_count = 0
    return jsonify({"status": "ok", "occupancy": 0})

# --- CONFIGURATION ---
SCRIPT_DIR           = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH           = os.path.join(SCRIPT_DIR, "detect.tflite")
LABEL_PATH           = os.path.join(SCRIPT_DIR, "labelmap.txt")
CONFIDENCE_THRESHOLD = 0.5   # Minimum confidence to detect a person
SKIP_FRAMES          = 2     # Process every nth frame to improve FPS
TARGET_FPS           = 20    # Hard cap — limits CPU, RAM, and stream bandwidth
FRAME_INTERVAL       = 1.0 / TARGET_FPS
CAMERA_WIDTH         = 1280  # Capture resolution — lower = faster, higher = better quality
CAMERA_HEIGHT        = 720
JPEG_QUALITY         = 85     # MJPEG stream quality 1-100 (85 is near-lossless at ~35% less bandwidth)

# Initialize Interpreter
if not os.path.exists(MODEL_PATH):
    sys.exit(f"[ERROR] Model not found: {MODEL_PATH}\n"
             f"        Download detect.tflite and place it next to main.py")

interpreter = Interpreter(model_path=MODEL_PATH)
interpreter.allocate_tensors()
input_details  = interpreter.get_input_details()
output_details = interpreter.get_output_details()

# Determine expected input dtype (uint8 for quantized, float32 for full-precision)
INPUT_DTYPE  = input_details[0]['dtype']   # np.uint8 or np.float32
INPUT_HEIGHT = input_details[0]['shape'][1]
INPUT_WIDTH  = input_details[0]['shape'][2]
print(f"[INFO] Model input: {INPUT_WIDTH}x{INPUT_HEIGHT}, dtype={INPUT_DTYPE.__name__}")

# --- CENTROID TRACKER CLASS [cite: 14, 21] ---
class CentroidTracker:
    def __init__(self, maxDisappeared=50):
        self.nextObjectID = 0
        self.objects = {}       # Dictionary of ID: Centroid (x, y)
        self.disappeared = {}   # Dictionary of ID: Frames missing
        self.maxDisappeared = maxDisappeared

    def register(self, centroid):
        self.objects[self.nextObjectID] = centroid
        self.disappeared[self.nextObjectID] = 0
        self.nextObjectID += 1

    def deregister(self, objectID):
        del self.objects[objectID]
        del self.disappeared[objectID]

    def update(self, rects):
        # If no detections, mark existing objects as disappeared
        if len(rects) == 0:
            for objectID in list(self.disappeared.keys()):
                self.disappeared[objectID] += 1
                if self.disappeared[objectID] > self.maxDisappeared:
                    self.deregister(objectID)
            return self.objects

        # Initialize input centroids
        inputCentroids = np.zeros((len(rects), 2), dtype="int")
        for (i, (startX, startY, endX, endY)) in enumerate(rects):
            cX = int((startX + endX) / 2.0)
            cY = int((startY + endY) / 2.0)
            inputCentroids[i] = (cX, cY)

        # If we are not tracking any objects, register all input centroids
        if len(self.objects) == 0:
            for i in range(0, len(inputCentroids)):
                self.register(inputCentroids[i])
        
        # Otherwise, match input centroids to existing object IDs
        else:
            objectIDs       = list(self.objects.keys())
            objectCentroids = list(self.objects.values())

            # Vectorised Euclidean distance matrix: shape (n_objects, n_detections)
            D = np.linalg.norm(
                np.array(objectCentroids)[:, np.newaxis] - inputCentroids[np.newaxis, :],
                axis=2
            )

            # Hungarian algorithm — guaranteed optimal, no greedy collision bugs
            row_indices, col_indices = linear_sum_assignment(D)

            usedRows = set()
            usedCols = set()

            for (row, col) in zip(row_indices, col_indices):
                objectID = objectIDs[row]
                self.objects[objectID] = inputCentroids[col]
                self.disappeared[objectID] = 0
                usedRows.add(row)
                usedCols.add(col)

            # Register new objects
            unusedCols = set(range(0, D.shape[1])).difference(usedCols)
            for col in unusedCols:
                self.register(inputCentroids[col])

            # Deregister lost objects
            unusedRows = set(range(0, D.shape[0])).difference(usedRows)
            for row in unusedRows:
                objectID = objectIDs[row]
                self.disappeared[objectID] += 1
                if self.disappeared[objectID] > self.maxDisappeared:
                    self.deregister(objectID)

        return self.objects

# --- MAIN EXECUTION ---
ct = CentroidTracker()

# On Windows use DirectShow backend to avoid buffering/lag
if IS_WINDOWS:
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
else:
    cap = cv2.VideoCapture(0)  # Pi Camera or USB webcam

if not cap.isOpened():
    sys.exit("[ERROR] Could not open camera. Check that a webcam/Pi Camera is connected.")

# Set camera resolution and cap FPS at the source to reduce buffer pressure
cap.set(cv2.CAP_PROP_FRAME_WIDTH,  CAMERA_WIDTH)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
cap.set(cv2.CAP_PROP_FPS, TARGET_FPS)

# Global Variables
total_count    = 0
trackableObjects = {}  # Store previous X position to determine direction
frame_count    = 0
objects        = {}    # last known tracked objects (used for skipped frames)

# Start MJPEG server in background thread
STREAM_PORT = 8080
server_thread = threading.Thread(target=_start_server, args=(STREAM_PORT,), daemon=True)
server_thread.start()
print(f"[INFO] Live stream at  http://localhost:{STREAM_PORT}  — open in your browser")
print("[INFO] Press Ctrl+C to quit.")

# Auto-open browser after a short delay
def _open_browser():
    time.sleep(1.5)
    webbrowser.open(f"http://localhost:{STREAM_PORT}")
threading.Thread(target=_open_browser, daemon=True).start()

try:
    while True:
        loop_start = time.time()

        ret, frame = cap.read()
        if not ret:
            print("[WARN] Failed to grab frame. Exiting.")
            break

        frame_count += 1
        frame = cv2.resize(frame, (CAMERA_WIDTH, CAMERA_HEIGHT))
        (H, W) = frame.shape[:2]

        # Define Virtual Boundary (vertical line in centre)
        cv2.line(frame, (W // 2, 0), (W // 2, H), (0, 255, 255), 2)

        # 2. Object Detection — only on every nth frame (SKIP_FRAMES)
        if frame_count % SKIP_FRAMES == 0:
            resized_frame = cv2.resize(frame, (INPUT_WIDTH, INPUT_HEIGHT))

            # Handle quantized (uint8) vs full-precision (float32) models
            if INPUT_DTYPE == np.float32:
                input_data = np.expand_dims(
                    resized_frame.astype(np.float32) / 255.0, axis=0)
            else:
                input_data = np.expand_dims(
                    resized_frame.astype(np.uint8), axis=0)

            interpreter.set_tensor(input_details[0]['index'], input_data)
            interpreter.invoke()

            boxes   = interpreter.get_tensor(output_details[0]['index'])[0]
            classes = interpreter.get_tensor(output_details[1]['index'])[0]
            scores  = interpreter.get_tensor(output_details[2]['index'])[0]

            rects = []

            # Filter detections: persons only (COCO class 0), above confidence threshold
            for i in range(len(scores)):
                if scores[i] > CONFIDENCE_THRESHOLD and int(classes[i]) == 0:
                    ymin, xmin, ymax, xmax = boxes[i]
                    startX = int(xmin * W)
                    startY = int(ymin * H)
                    endX   = int(xmax * W)
                    endY   = int(ymax * H)
                    rects.append((startX, startY, endX, endY))
                    cv2.rectangle(frame, (startX, startY), (endX, endY), (0, 255, 0), 2)

            # 3. Update Tracker
            objects = ct.update(rects)

        # 4. Counting Logic (Virtual Boundary Crossing)
        for (objectID, centroid) in objects.items():
            to = trackableObjects.get(objectID, None)

            if to is None:
                trackableObjects[objectID] = centroid[0]  # Store X coordinate
            else:
                x_previous = to
                x_current  = centroid[0]
                boundary   = W // 2

                # Moving Left to Right (Exit)
                if x_previous < boundary and x_current >= boundary:
                    total_count -= 1
                    db.log_event("exit", objectID, total_count)
                    trackableObjects[objectID] = x_current
                    print(f"[EVENT] Exit  — Occupancy: {total_count}")

                # Moving Right to Left (Entry)
                elif x_previous > boundary and x_current <= boundary:
                    total_count += 1
                    db.log_event("entry", objectID, total_count)
                    trackableObjects[objectID] = x_current
                    print(f"[EVENT] Entry — Occupancy: {total_count}")

            # Draw centroid and ID
            text = "ID {}".format(objectID)
            cv2.putText(frame, text, (centroid[0] - 10, centroid[1] - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
            cv2.circle(frame, (centroid[0], centroid[1]), 4, (0, 255, 0), -1)

        # Remove stale entries for IDs the tracker has already deregistered
        for stale_id in list(trackableObjects.keys()):
            if stale_id not in objects:
                del trackableObjects[stale_id]

        # 5. Dashboard / Display
        _proc     = psutil.Process(os.getpid())
        ram_mb    = _proc.memory_info().rss / 1024 / 1024   # this process only
        sys_ram   = psutil.virtual_memory()
        sys_used  = sys_ram.used  / 1024 / 1024
        sys_total = sys_ram.total / 1024 / 1024

        info_text = f"Occupancy: {total_count}"
        ram_text  = f"RAM: {ram_mb:.0f} MB (sys {sys_used:.0f}/{sys_total:.0f} MB)"

        cv2.putText(frame, info_text, (10, H - 40),
            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
        cv2.putText(frame, ram_text, (10, H - 10),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1)

        # Print RAM to terminal every 60 frames (~3 s at 20 FPS)
        if frame_count % 60 == 0:
            elapsed_fps = 60 / (time.time() - loop_start + 0.001)
            print(
                f"[MEM] Process: {ram_mb:.1f} MB  |  System: {sys_used:.0f}/{sys_total:.0f} MB  ({sys_ram.percent:.1f}% used)")
            db.log_snapshot(total_count, ram_mb, sys_used, elapsed_fps)

        # Encode frame as JPEG and push to MJPEG stream (lower quality = less RAM)
        ok, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if ok:
            with _frame_lock:
                _latest_frame = buffer.tobytes()
            _frame_event.set()   # wake the generator — send exactly one frame

        # FPS cap: sleep for the remainder of the frame interval
        elapsed = time.time() - loop_start
        sleep_t = FRAME_INTERVAL - elapsed
        if sleep_t > 0:
            time.sleep(sleep_t)

except KeyboardInterrupt:
    print("\n[INFO] Stopped by user.")
finally:
    cap.release()
    db.shutdown()