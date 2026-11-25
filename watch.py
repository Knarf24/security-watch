"""Security Watch: the camera brain, in plain Python (OpenCV + NumPy).

It combines four GeeksforGeeks projects:
  * Background subtraction (MOG2): notices anything that moves in a still camera view.
  * Pedestrian detection: finds people, with a NanoDet neural network or the classic HOG people detector.
  * Weapon check: flags knives and bats the network can see (see the README for why guns are not included).
  * Alert rules: a person while the shop is closed, or a weapon at any time, raises an alarm.
Recording the clip and the Telegram message are done by the caller (the web page or desktop.py).

The same file runs in the browser (Pyodide) and on a normal Python install.
"""
import json
import time

import cv2
import numpy as np

# The 80 COCO classes NanoDet was trained on (we only use a few of them).
PERSON = 0
WEAPONS = {34: "bat", 43: "knife"}


def _letterbox(img, size):
    """Scale img to fit a size x size square, padding the rest. Returns the square, scale and offsets."""
    h, w = img.shape[:2]
    s = min(size / w, size / h)
    nw, nh = int(round(w * s)), int(round(h * s))
    out = np.zeros((size, size, 3), np.uint8)
    top, left = (size - nh) // 2, (size - nw) // 2
    out[top:top + nh, left:left + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    return out, s, left, top


class NanoDet:
    """NanoDet-Plus object detector (OpenCV Model Zoo), run with cv2.dnn."""

    size = 416
    strides = (8, 16, 32, 64)
    reg_max = 7

    def __init__(self, model_path):
        self.net = cv2.dnn.readNet(model_path)
        self.mean = np.array([103.53, 116.28, 123.675], np.float32)
        self.std = np.array([57.375, 57.12, 58.395], np.float32)
        self.project = np.arange(self.reg_max + 1, dtype=np.float32)
        self.anchors = []
        for st in self.strides:
            n = int(np.ceil(self.size / st))
            xv, yv = np.meshgrid(np.arange(n) * st, np.arange(n) * st)
            self.anchors.append(np.column_stack((xv.ravel(), yv.ravel())).astype(np.float32) + 0.5 * (st - 1))

    def detect(self, bgr, min_score=0.4, classes=None):
        img, s, left, top = _letterbox(bgr, self.size)
        blob = cv2.dnn.blobFromImage((img.astype(np.float32) - self.mean) / self.std)
        self.net.setInput(blob)
        outs = self.net.forward(self.net.getUnconnectedOutLayersNames())
        boxes, scores, ids = [], [], []
        for st, cls, reg, anc in zip(self.strides, outs[::2], outs[1::2], self.anchors):
            cls, reg = cls.reshape(-1, 80), reg.reshape(-1, 4 * (self.reg_max + 1))
            cid = cls.argmax(1)
            conf = cls[np.arange(len(cid)), cid]
            keep = conf >= min_score
            if classes is not None:
                keep &= np.isin(cid, list(classes))
            if not keep.any():
                continue
            r = reg[keep].reshape(-1, self.reg_max + 1)
            e = np.exp(r - r.max(1, keepdims=True))
            dist = ((e / e.sum(1, keepdims=True)) @ self.project).reshape(-1, 4) * st
            a = anc[keep]
            x1, y1 = a[:, 0] - dist[:, 0], a[:, 1] - dist[:, 1]
            x2, y2 = a[:, 0] + dist[:, 2], a[:, 1] + dist[:, 3]
            boxes += np.column_stack((x1, y1, x2 - x1, y2 - y1)).tolist()
            scores += conf[keep].tolist()
            ids += cid[keep].tolist()
        out = []
        if boxes:
            for i in np.array(cv2.dnn.NMSBoxes(boxes, scores, min_score, 0.5)).ravel():
                x, y, w, h = boxes[i]
                out.append((int(ids[i]), float(scores[i]),
                            [(x - left) / s, (y - top) / s, w / s, h / s]))
        return out


class HogPeople:
    """The classic HOG + linear SVM people detector built into OpenCV (fast, upright people only)."""

    def __init__(self):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def detect(self, bgr, min_score=0.4, classes=None):
        h, w = bgr.shape[:2]
        s = 320 / w
        small = cv2.resize(bgr, (320, int(h * s)))
        pad = int(small.shape[0] * 0.12)  # room above and below, so people cut off by the frame edge still fit
        small = cv2.copyMakeBorder(small, pad, pad, 0, 0, cv2.BORDER_REPLICATE)
        rects, weights = self.hog.detectMultiScale(small, winStride=(4, 4), padding=(8, 8), scale=1.05)
        if len(rects) == 0:
            return []
        weights = np.ravel(weights).astype(float)
        conf = 1 / (1 + np.exp(-(weights - 0.3) * 3))  # squash SVM margin into 0..1
        rects = [list(map(float, r)) for r in rects]
        keep = np.array(cv2.dnn.NMSBoxes(rects, conf.tolist(), min_score, 0.4)).ravel()
        return [(PERSON, float(conf[i]), [rects[i][0] / s, (rects[i][1] - pad) / s, rects[i][2] / s, rects[i][3] / s])
                for i in keep]


class Watch:
    """One camera. Call process() for each frame; it returns what it saw and whether to raise an alarm."""

    def __init__(self, model_path="models/object_detection_nanodet_2022nov.onnx"):
        self.model_path = model_path
        self.detectors = {}
        self.settings = {
            "detector": "nanodet",     # "nanodet" (more accurate) or "hog" (classic, faster)
            "min_score": 0.45,         # how sure a detection must be
            "motion": 0.004,           # share of the picture that must change to count as motion
            "armed": "hours",          # "always", "hours" (only when the shop is closed) or "off"
            "open_from": "08:00",      # shop opening hours: no person alarms between these times
            "open_until": "18:00",
            "weapons": True,           # alarm on knives and bats at any time
            "cooldown": 60,            # seconds between repeat alarms while someone stays in view
            "recheck": 4,              # seconds between person checks when nothing is moving
        }
        self.reset()

    # ---- settings --------------------------------------------------------------
    def configure(self, settings_json):
        self.settings.update(json.loads(settings_json))
        return json.dumps(self.settings)

    def reset(self):
        self.bg = cv2.createBackgroundSubtractorMOG2(history=400, varThreshold=40, detectShadows=True)
        self.frames = 0
        self.last_detect = -1e9
        self.last_seen = -1e9
        self.last_alert = {}
        self.last_present = {}
        self.dets = []

    def _detector(self):
        name = self.settings["detector"]
        if name not in self.detectors:
            self.detectors[name] = NanoDet(self.model_path) if name == "nanodet" else HogPeople()
        return self.detectors[name]

    def is_armed(self, minutes=None):
        """True when person alarms are on. minutes = local time of day in minutes (default: now)."""
        mode = self.settings["armed"]
        if mode != "hours":
            return mode == "always"
        if minutes is None:
            t = time.localtime()
            minutes = t.tm_hour * 60 + t.tm_min
        o = _minutes(self.settings["open_from"])
        c = _minutes(self.settings["open_until"])
        is_open = o <= minutes < c if o <= c else (minutes >= o or minutes < c)
        return not is_open

    # ---- one frame ---------------------------------------------------------------
    def motion(self, bgr):
        """Background subtraction: boxes around moving things, and the share of the picture that moved."""
        h, w = bgr.shape[:2]
        s = 320 / w
        small = cv2.GaussianBlur(cv2.resize(bgr, (320, int(h * s))), (5, 5), 0)
        mask = self.bg.apply(small, learningRate=-1 if self.frames > 30 else 0.1)
        mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)[1]  # drop shadows (grey 127)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=2)
        ratio = float(np.count_nonzero(mask)) / mask.size
        boxes = []
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            if cv2.contourArea(c) < mask.size * 0.002:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            boxes.append([x / s, y / s, bw / s, bh / s])
        return ratio, boxes

    def process(self, bgr, now=None, minutes=None):
        """Look at one BGR frame. now = time in seconds (default: clock). Returns a dict."""
        now = time.time() if now is None else now
        st = self.settings
        self.frames += 1
        warming = self.frames <= 15
        ratio, mboxes = self.motion(bgr)
        moving = not warming and ratio >= st["motion"]

        armed = self.is_armed(minutes)
        want_people = armed or st["armed"] == "off"  # still show people when alarms are off
        need = moving or (now - self.last_seen) < 3 or (now - self.last_detect) >= st["recheck"]
        detected = False
        if need and (want_people or st["weapons"]):
            classes = set()
            if want_people:
                classes.add(PERSON)
            if st["weapons"]:
                classes |= set(WEAPONS)
            t0 = time.time()
            raw = self._detector().detect(bgr, st["min_score"], classes)
            self.detect_ms = (time.time() - t0) * 1000
            self.dets = [{"label": "person" if c == PERSON else WEAPONS.get(c, str(c)),
                          "kind": "person" if c == PERSON else "weapon",
                          "score": round(sc, 2), "box": [round(v, 1) for v in b]} for c, sc, b in raw]
            self.last_detect = now
            detected = True
            if any(d["kind"] == "person" for d in self.dets):
                self.last_seen = now
        people = [d for d in self.dets if d["kind"] == "person"]
        weapons = [d for d in self.dets if d["kind"] == "weapon"]

        # A new visit (nobody seen for 5 s, then someone again) always gets its own alarm.
        for kind, present in (("person", people), ("weapon", weapons)):
            if present:
                if now - self.last_present.get(kind, -1e9) > 5:
                    self.last_alert.pop(kind, None)
                self.last_present[kind] = now

        alerts = []
        if weapons and st["weapons"]:
            alerts += self._alert("weapon", now, "⚠️ Possible weapon seen: " +
                                  ", ".join(sorted({d["label"] for d in weapons})))
        if people and armed:
            n = len(people)
            alerts += self._alert("person", now, f"🚨 {n} {'person' if n == 1 else 'people'} in view while the shop is closed")

        if warming:
            status = "Learning the empty scene…"
        elif weapons:
            status = "Possible weapon in view"
        elif people:
            status = f"{len(people)} {'person' if len(people) == 1 else 'people'} in view" + ("" if armed else " (alarm off)")
        elif moving:
            status = "Movement"
        else:
            status = "All quiet"
        return {
            "motion": round(ratio, 4), "moving": moving, "motion_boxes": mboxes,
            "detections": self.dets, "detected": detected, "armed": armed,
            "people": len(people), "weapons": len(weapons), "alerts": alerts,
            "active": bool(people or weapons or moving), "status": status,
            "detect_ms": round(getattr(self, "detect_ms", 0)),
        }

    def _alert(self, kind, now, text):
        if now - self.last_alert.get(kind, -1e9) < self.settings["cooldown"]:
            return []
        self.last_alert[kind] = now
        return [{"kind": kind, "text": text}]

    # ---- called from the web page ------------------------------------------------
    def process_rgba(self, data, width, height, now, minutes):
        buf = data.to_py() if hasattr(data, "to_py") else data
        rgba = np.frombuffer(buf, np.uint8).reshape(height, width, 4)
        return json.dumps(self.process(cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR), now, minutes))


def _minutes(hhmm):
    h, m = (hhmm or "0:0").split(":")[:2]
    return int(h) * 60 + int(m)


def draw(bgr, result):
    """Draws the boxes and status on a frame (used by desktop.py; the web page draws its own)."""
    for b in result["motion_boxes"]:
        x, y, w, h = map(int, b)
        cv2.rectangle(bgr, (x, y), (x + w, y + h), (200, 200, 200), 1)
    for d in result["detections"]:
        x, y, w, h = map(int, d["box"])
        col = (40, 40, 230) if d["kind"] == "weapon" else ((60, 60, 220) if result["armed"] else (80, 180, 60))
        cv2.rectangle(bgr, (x, y), (x + w, y + h), col, 2)
        cv2.putText(bgr, f"{d['label']} {d['score']:.0%}", (x, max(14, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 2)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S") + "  " + result["status"]
    cv2.putText(bgr, stamp, (10, bgr.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 3)
    cv2.putText(bgr, stamp, (10, bgr.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)
    return bgr
