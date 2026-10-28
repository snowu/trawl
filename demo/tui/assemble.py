"""build/tui/raw.mp4 + stills -> demo/trawl-demo.mp4 + .gif (intro, framed recording with keycap captions, render payoff, outro)."""
import json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, '..', 'build', 'tui')
S = lambda n: os.path.join(BUILD, 'stills', n)
FPS = 60
W, H, VW, VH, VX, VY = 1920, 1080, 1600, 866, 160, 52
INTRO, GRID, OUTRO, XF = 2.6, 3.2, 3.2, 0.45

tl = json.load(open(os.path.join(BUILD, 'timeline.json')))
rec_start = float(open(os.path.join(BUILD, 'rec_start')).read())
start = tl['t0'] - rec_start + 0.45                       # first frame: empty prompt, just before typing
raw_dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                         '-of', 'csv=p=0', os.path.join(BUILD, 'raw.mp4')]))
main = raw_dur - start - 0.7

inputs = ['-i', os.path.join(BUILD, 'raw.mp4'),
          '-loop', '1', '-framerate', str(FPS), '-t', f'{main}', '-i', S('bg.png'),
          '-loop', '1', '-framerate', str(FPS), '-t', f'{main}', '-i', S('mask.png'),
          '-loop', '1', '-framerate', str(FPS), '-t', f'{INTRO}', '-i', S('intro.png'),
          '-loop', '1', '-framerate', str(FPS), '-t', f'{GRID}', '-i', S('grid.png'),
          '-loop', '1', '-framerate', str(FPS), '-t', f'{OUTRO}', '-i', S('outro.png')]
f = [
    f'[0:v]trim=start={start:.3f}:duration={main:.3f},setpts=PTS-STARTPTS,fps={FPS},'
    f'scale={VW}:{VH}:flags=lanczos,format=rgba[rec]',
    '[2:v]format=gray[mask]',
    '[rec][mask]alphamerge[recm]',
    f'[1:v][recm]overlay={VX}:{VY}:shortest=1,format=rgba[m0]',
]
last = 'm0'
for i, c in enumerate(tl['captions']):
    t = c['t'] - rec_start - start
    d = c['dur']
    inputs += ['-loop', '1', '-framerate', str(FPS), '-t', f'{d:.3f}', '-i', S(f'cap{i:02d}.png')]
    n = 6 + i
    band_mid = VY + VH + (H - VY - VH) // 2
    f.append(f'[{n}:v]format=rgba,fade=in:st=0:d=0.14:alpha=1,fade=out:st={d - 0.2:.3f}:d=0.2:alpha=1,'
             f'setpts=PTS-STARTPTS+{t:.3f}/TB[c{i}]')
    f.append(f"[{last}][c{i}]overlay=x=(W-w)/2:y={band_mid}-h/2:eof_action=pass:"
             f"enable='between(t,{t:.3f},{t + d:.3f})'[m{i + 1}]")
    last = f'm{i + 1}'
f.append(f'[{last}]format=yuv420p,setsar=1[main]')

# Title cards: a slow push-in keeps them alive.
for idx, name, dur in ((3, 'intro', INTRO), (4, 'grid', GRID), (5, 'outro', OUTRO)):
    frames = int(dur * FPS)
    f.append(f"[{idx}:v]scale=3840:-1,zoompan=z='1+0.04*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
             f':d=1:s={W}x{H}:fps={FPS},trim=duration={dur},format=yuv420p,setsar=1[{name}]')

f.append(f'[intro][main]xfade=transition=fade:duration={XF}:offset={INTRO - XF:.3f}[a]')
o2 = INTRO + main - 2 * XF
f.append(f'[a][grid]xfade=transition=slideleft:duration={XF}:offset={o2:.3f}[b]')
o3 = o2 + GRID - XF
f.append(f'[b][outro]xfade=transition=fade:duration={XF}:offset={o3:.3f}[out]')

out = os.path.join(HERE, '..', 'trawl-demo.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(f), '-map', '[out]',
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                out], check=True)
print(out, round(o3 + OUTRO, 1), 's')

# GIF for READMEs (GitHub caps them at 10 MB): 10 fps, 880 px, one palette for the whole clip.
gif = os.path.join(HERE, '..', 'trawl-demo.gif')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', out, '-filter_complex',
                'fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];'
                '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif], check=True)
print(gif, os.path.getsize(gif) // 1024, 'KiB')
