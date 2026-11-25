#!/bin/sh
# Puts the web page, the Python code and the model together in _site/ (what GitHub Pages serves).
set -e
rm -rf _site
mkdir -p _site/models
cp -r web/. _site/
cp watch.py _site/
cp models/object_detection_nanodet_2022nov.onnx _site/models/
touch _site/.nojekyll
