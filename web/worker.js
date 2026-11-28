// Runs the Python code (watch.py) in a background thread, so the video stays smooth
// while OpenCV looks at each frame.
importScripts("pyodide/pyodide.js", "pyfast.js");

let W = null;

async function init() {
  const base = new URL("./", self.location.href).href;
  // The code and the detector download while Python starts.
  const files = Promise.all(["watch.py", "models/object_detection_nanodet_2022nov.onnx"].map(async (f) => {
    const r = await fetch(base + f);
    if (!r.ok) throw new Error("Could not load " + f);
    return [f, new Uint8Array(await r.arrayBuffer())];
  }));
  files.catch(() => {}); // reported below
  const py = await loadPyodideFast({ indexURL: base + "pyodide/" });
  self.postMessage({ type: "loading", text: "Loading OpenCV and NumPy…" });
  await py.loadPackage(["numpy", "opencv-python"]);
  self.postMessage({ type: "loading", text: "Loading the person detector…" });
  py.FS.mkdirTree("/home/pyodide/models");
  for (const [f, bytes] of await files) py.FS.writeFile("/home/pyodide/" + f, bytes);
  py.runPython("import watch\nW = watch.Watch()\nW._detector()");
  W = py.globals.get("W");
}

const ready = init().then(
  () => self.postMessage({ type: "ready" }),
  (e) => self.postMessage({ type: "error", text: String(e && e.message || e) })
);

self.onmessage = async (e) => {
  const m = e.data;
  await ready;
  if (!W) return;
  try {
    if (m.type === "config") {
      self.postMessage({ type: "config", settings: JSON.parse(W.configure(JSON.stringify(m.settings))) });
    } else if (m.type === "reset") {
      W.reset();
    } else if (m.type === "frame") {
      const t0 = performance.now();
      const res = JSON.parse(W.process_rgba(new Uint8Array(m.buffer), m.width, m.height, m.now, m.minutes));
      res.ms = Math.round(performance.now() - t0);
      self.postMessage({ type: "result", id: m.id, result: res });
    }
  } catch (err) {
    self.postMessage({ type: "result", id: m.id, error: String(err && err.message || err) });
  }
};
