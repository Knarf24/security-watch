"""Security Watch on a normal computer: webcam (or a video file), saved alarm clips and Telegram alerts.

    pip install -r requirements.txt
    python desktop.py                     # webcam 0
    python desktop.py web/sample/shop-after-hours.mp4
    TELEGRAM_TOKEN=123:abc TELEGRAM_CHAT=456 python desktop.py   # with phone alerts

Clips are saved in ./clips as .mp4 (cv2.VideoWriter). Press q to quit.
"""
import json
import os
import sys
import time
import urllib.request
import uuid

import cv2

from watch import Watch, draw

QUIET_STOP = 6  # seconds of nothing going on before a clip ends


def telegram(method, fields, file_field=None, file_path=None):
    token, chat = os.environ.get("TELEGRAM_TOKEN"), os.environ.get("TELEGRAM_CHAT")
    if not (token and chat):
        return
    fields = {"chat_id": chat, **fields}
    boundary = uuid.uuid4().hex
    body = b""
    for k, v in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    if file_path:
        with open(file_path, "rb") as f:
            body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
                     f'filename="{os.path.basename(file_path)}"\r\n\r\n').encode() + f.read() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            json.load(r)
    except Exception as e:  # never stop watching because a message failed
        print("Telegram:", e)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 0
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 15
    watch = Watch(os.path.join(os.path.dirname(__file__), "models", "object_detection_nanodet_2022nov.onnx"))
    watch.configure(json.dumps({"armed": os.environ.get("ARMED", "always")}))
    os.makedirs("clips", exist_ok=True)
    writer, clip, last_active = None, None, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame.shape[1] > 640:
            frame = cv2.resize(frame, (640, int(frame.shape[0] * 640 / frame.shape[1])))
        res = watch.process(frame)
        shown = draw(frame.copy(), res)
        now = time.time()
        for a in res["alerts"]:
            print(time.strftime("%H:%M:%S"), a["text"])
            snap = os.path.join("clips", f"alarm-{time.strftime('%Y%m%d-%H%M%S')}.jpg")
            cv2.imwrite(snap, shown)
            telegram("sendPhoto", {"caption": a["text"]}, "photo", snap)
            if writer is None:
                clip = snap[:-4] + ".mp4"
                writer = cv2.VideoWriter(clip, cv2.VideoWriter_fourcc(*"mp4v"), fps, shown.shape[1::-1])
        if res["active"]:
            last_active = now
        if writer is not None:
            writer.write(shown)
            if now - last_active > QUIET_STOP:
                writer.release()
                writer = None
                print("Saved", clip)
                telegram("sendVideo", {"caption": "Clip of the alarm"}, "video", clip)
        cv2.imshow("Security Watch (q to quit)", shown)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
    if writer is not None:
        writer.release()
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
