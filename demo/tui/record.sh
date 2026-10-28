#!/usr/bin/env bash
# Records one take: Ghostty on workspace 9 running director.py, captured with gpu-screen-recorder -> build/tui/raw.mp4
# Takes over workspace 9 for ~40s; hands off the keyboard and mouse meanwhile.
set -u
D=$(cd "$(dirname "$0")" && pwd)
B="$D/../build/tui"
mkdir -p "$B" && cd "$B"
rm -rf go done timeline.json raw.mp4 shop out
# The picker scopes to the git repo it runs in, so the shop gets a repo of its own.
cp -r "$D/../shop" shop && git -C shop init -q

hyprctl dispatch 'hl.dsp.focus({ workspace = "9" })' >/dev/null
sleep 0.4
ghostty --gtk-single-instance=false --class=dev.trawl.demo --font-size=15 --background-opacity=1 \
  --window-padding-x=28 --window-padding-y=22 -e python3 -I "$D/director.py" >/dev/null 2>&1 &
GHOSTTY=$!
sleep 3
G=$(hyprctl clients -j | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    if c['class']=='dev.trawl.demo': print('%dx%d+%d+%d'%(c['size'][0]//2*2,c['size'][1]//2*2,c['at'][0],c['at'][1]))")
echo "region $G"

# HDMI-A-1 hangs off the NVIDIA card: capture through it.
__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia \
  __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json \
  gpu-screen-recorder -w region -region "$G" -f 60 -cursor no -k h264 -q very_high -o "$B/raw.mp4" >gsr.log 2>&1 &
GSR=$!
python3 -c 'import time; print(time.time())' >rec_start
sleep 1.5
touch go
for _ in $(seq 1 160); do [ -f done ] && break; sleep 0.5; done
sleep 1
kill -INT $GSR; wait $GSR
kill $GHOSTTY 2>/dev/null
hyprctl dispatch 'hl.dsp.focus({ workspace = "1" })' >/dev/null
mv shop/out out
ffprobe -v error -show_entries format=duration -of csv=p=0 raw.mp4
