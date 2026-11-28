# 🛡️ Security Watch

**Live demo:** https://knarf24.github.io/security-watch/

**The problem:** small shops can't watch CCTV all day.

**The app:** point a camera at the room. It notices movement, spots **people while the shop is closed**
and **knives or bats at any time**, records the clip and **pings your phone** on Telegram.
A sample video is built in, so it works without a camera.

It is written in **Python** (OpenCV + NumPy) and runs **inside your browser** with
[Pyodide](https://pyodide.org), in a background thread so the video stays smooth. It is hosted free on GitHub Pages.

> 🔒 **Privacy:** the video is analysed on the device and never uploaded. Clips stay in the browser tab
> until you download them. The only thing that leaves the device is the Telegram alert you set up,
> sent straight to your own bot (the token is kept only in that browser). Tell people when a camera is recording.

Built by combining five GeeksforGeeks Python projects:

| GeeksforGeeks project | What it does here |
|---|---|
| [Background subtraction](https://www.geeksforgeeks.org/python/background-subtraction-opencv/) | MOG2 learns the empty room and marks anything that moves; detection only runs when needed |
| [Pedestrian Detection](https://www.geeksforgeeks.org/python/pedestrian-detection-using-opencv-python/) | Finds people with a NanoDet network, or OpenCV's classic HOG people detector |
| [Gun Detection](https://www.geeksforgeeks.org/machine-learning/gun-detection-using-python-opencv/) | Weapon check at any time of day (knives and bats, see note below) |
| [Saving Operated Video from a Webcam](https://www.geeksforgeeks.org/python/saving-operated-video-from-a-webcam-using-opencv/) | Records the annotated video of each alarm (browser: MediaRecorder, desktop: `cv2.VideoWriter`) |
| [Send Message to Telegram User](https://www.geeksforgeeks.org/python/send-message-to-telegram-user-using-python/) | Sends a snapshot and the clip to your phone through your own Telegram bot |

> **About guns:** the GeeksforGeeks version uses a home-made Haar cascade that gives many false alarms.
> This app uses NanoDet, trained on the 80 COCO everyday objects, which include knives and baseball bats but
> not guns. Reliable gun detection needs a model trained on gun images; `watch.py` has a `WEAPONS` table
> where such a model's classes can be added.

## How it works

1. **Background subtraction:** `cv2.createBackgroundSubtractorMOG2` on a 320 px copy of each frame, shadows
   dropped, noise cleaned with opening and dilation. The first frames teach it the empty scene.
2. **Detection:** when something moves (or every few seconds, or while people are in view), NanoDet-Plus
   (`cv2.dnn`, OpenCV Model Zoo) looks for people, knives and bats. The HOG option is faster but finds only upright people.
3. **Alarm rules:** person alarm *always*, *only outside opening hours*, or *off*; weapon alarm at any time.
   A new visit always raises an alarm; while someone stays in view it repeats at most once a minute.
4. **Clip:** recording starts with the alarm and stops after 6 quiet seconds (at most 1 minute).
5. **Telegram:** `sendPhoto` with the snapshot, then `sendDocument` with the clip.

## Files

- `watch.py`: motion, detectors and alarm rules (plain Python, also runs on a normal install)
- `desktop.py`: the same watch on a computer with a webcam, saving `.mp4` clips and sending Telegram alerts
- `web/`: the page (`index.html`, `main.js` for camera, drawing, recording and Telegram, `worker.js` running
  Python in the background, `style.css`), the sample video and the Pyodide runtime with OpenCV
- `models/`: NanoDet-Plus from the [OpenCV Model Zoo](https://github.com/opencv/opencv_zoo)
- `build_site.sh` and `.github/workflows/pages.yml`: every push to `main` publishes to GitHub Pages

## Run it on your computer

In the browser:

```bash
sh build_site.sh
cd _site && python -m http.server 8000
```

Then open http://localhost:8000.

As a desktop app with your webcam:

```bash
pip install -r requirements.txt
TELEGRAM_TOKEN=123456:your-bot-token TELEGRAM_CHAT=your-chat-id python desktop.py
```

## Fast loading

The page shows straight away and Python starts in the background, so nothing waits on a
"Starting Python" screen. Anything that needs Python simply waits for it if you are quicker.

- **Saved on the device** (`web/sw.js`): after the first visit, Python (Pyodide) and its packages are kept in
  the browser, so a refresh or a later visit doesn't download them again. Every app on the same site shares
  that one saved copy. The app's own files are still fetched fresh, so updates show up right away.
- **Quick restart** (`web/pyfast.js`): the first visit also saves a snapshot of a freshly started Python.
  Later visits restore it instead of starting Python from scratch (about 1.2 s down to 0.3 s on a laptop).
  If the snapshot can't be used (for example after a Pyodide upgrade), Python starts normally and a new one
  is saved.
- `build_site.sh` writes the Pyodide version into `sw.js`, so upgrading `web/pyodide/` needs no other change.


## Credits

- Person detector: NanoDet-Plus from the OpenCV Model Zoo (Apache 2.0)
- Sample video: [Intel IoT DevKit sample videos](https://github.com/intel-iot-devkit/sample-videos) (CC BY 4.0), shortened and resized
- Python in the browser: Pyodide (MPL 2.0)
- Project ideas: GeeksforGeeks
