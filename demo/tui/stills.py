"""Backdrop, window mask/shadow, caption pills and title cards for the demo, via ImageMagick."""
import json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, '..', 'build', 'tui')
OUT = os.path.join(BUILD, 'stills')
os.makedirs(OUT, exist_ok=True)
FONTS = os.path.join(HERE, '..', '..', 'fonts')
INTER_B, INTER = f'{FONTS}/Inter-Bold.ttf', f'{FONTS}/Inter-Regular.ttf'
MONO = '/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Bold.ttf'

W, H = 1920, 1080
VW, VH = 1600, 866          # recording, scaled
VX, VY = (W - VW) // 2, 52
RADIUS = 18


def magick(*args):
    subprocess.run(['magick', *args], check=True)


def p(name):
    return os.path.join(OUT, name)


# Backdrop: deep Tokyo Night gradient with two soft color glows, plus the window's shadow.
magick('-size', f'{W}x{H}', 'gradient:#16161e-#1f2335', '-rotate', '0',
       '(', '-size', f'{W}x{H}', 'xc:none', '-fill', '#7aa2f755', '-draw', 'circle 260,180 260,760', '-blur', '0x160', ')',
       '-composite',
       '(', '-size', f'{W}x{H}', 'xc:none', '-fill', '#bb9af744', '-draw', 'circle 1700,980 1700,1500', '-blur', '0x180', ')',
       '-composite', p('bg_plain.png'))
magick(p('bg_plain.png'),
       '(', '-size', f'{W}x{H}', 'xc:none', '-fill', '#000000b0',
       '-draw', f'roundrectangle {VX},{VY + 14} {VX + VW},{VY + VH + 14} {RADIUS},{RADIUS}', '-blur', '0x26', ')',
       '-composite',
       # hairline border around the window
       '-fill', 'none', '-stroke', '#414868', '-strokewidth', '2',
       '-draw', f'roundrectangle {VX - 1},{VY - 1} {VX + VW},{VY + VH} {RADIUS},{RADIUS}',
       p('bg.png'))

# Rounded-corner alpha mask for the recording.
magick('-size', f'{VW}x{VH}', 'xc:black', '-fill', 'white',
       '-draw', f'roundrectangle 0,0 {VW - 1},{VH - 1} {RADIUS},{RADIUS}', p('mask.png'))

# Caption pills: "key  ·  what it does" -> [ key ] what it does
tl = json.load(open(os.path.join(BUILD, 'timeline.json')))
for i, c in enumerate(tl['captions']):
    key, _, desc = (s.strip() for s in c['text'].partition('·'))
    if not desc:
        key, desc = '', key
    parts = []
    if key:
        magick('-background', 'none', '-font', MONO, '-pointsize', '30', '-fill', '#1a1b26',
               f'label:{key}', '-bordercolor', 'none', '-border', '18x8', p('k.png'))
        kw, kh = (int(v) for v in subprocess.check_output(['magick', 'identify', '-format', '%w %h', p('k.png')]).split())
        magick('-size', f'{kw}x{kh}', 'xc:none', '-fill', '#7aa2f7',
               '-draw', f'roundrectangle 0,0 {kw - 1},{kh - 1} 10,10', p('k.png'), '-composite', p('key.png'))
        parts.append(p('key.png'))
    magick('-background', 'none', '-font', INTER_B, '-pointsize', '32', '-fill', '#c0caf5', f'label:{desc}', p('d.png'))
    parts.append(p('d.png'))
    magick('-background', 'none', *parts, '-gravity', 'center', '+smush', '18', p('row.png'))
    rw, rh = (int(v) for v in subprocess.check_output(['magick', 'identify', '-format', '%w %h', p('row.png')]).split())
    bw, bh = rw + 44, rh + 26
    magick('-size', f'{bw}x{bh}', 'xc:none', '-fill', '#24283bf0', '-stroke', '#414868', '-strokewidth', '2',
           '-draw', f'roundrectangle 1,1 {bw - 2},{bh - 2} {bh // 2},{bh // 2}',
           p('row.png'), '-gravity', 'center', '-composite', p(f'cap{i:02d}.png'))

# Title cards share the plain backdrop; the intro gets a faint wall of real renders behind the title.
renders = sorted(os.path.join(BUILD, 'out', f) for f in os.listdir(os.path.join(BUILD, 'out')) if f.endswith('.png'))
magick('montage', *renders[:15], '-background', 'none', '-geometry', '360x240+18+18', '-tile', '5x3', p('wall.png'))
magick(p('bg_plain.png'),
       '(', p('wall.png'), '-resize', f'{W + 120}x', '-rotate', '-6', '-channel', 'A', '-evaluate', 'multiply', '0.16', '+channel', ')',
       '-gravity', 'center', '-composite',
       '-font', INTER_B, '-pointsize', '168', '-fill', '#c0caf5', '-annotate', '+0-70', 'trawl',
       '-font', INTER, '-pointsize', '44', '-fill', '#a9b1d6', '-annotate', '+0+70', 'Every Mermaid diagram in your repo.',
       '-font', INTER, '-pointsize', '44', '-fill', '#7aa2f7', '-annotate', '+0+130', 'Found, previewed, opened. From the terminal.',
       p('intro.png'))
magick(p('bg_plain.png'),
       '-gravity', 'center',
       '-font', INTER_B, '-pointsize', '150', '-fill', '#c0caf5', '-annotate', '+0-110', 'trawl',
       '-font', MONO, '-pointsize', '40', '-fill', '#9ece6a', '-annotate', '+0+30', 'git clone github.com/snowu/trawl && ./install.sh',
       '-font', INTER, '-pointsize', '38', '-fill', '#a9b1d6', '-annotate', '+0+110', 'then press  alt + m  in any repo',
       p('outro.png'))
print('ok')

# The payoff of `trawl render . -o out`: the files it just wrote, as cards.
outs = sorted(os.path.join(BUILD, 'out', f) for f in os.listdir(os.path.join(BUILD, 'out')))
cards = []
for i, f in enumerate(outs):
    c = p(f'card{i:02d}.png')
    magick(f, '-resize', '250x170', '-background', 'white', '-gravity', 'center', '-extent', '270x190',
           '(', '+clone', '-alpha', 'extract', '-fill', 'black', '-colorize', '100',
           '-fill', 'white', '-draw', 'roundrectangle 0,0 269,189 12,12', ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
           c)
    cards.append(c)
magick('montage', *cards, '-background', 'none', '-geometry', '+14+14', '-tile', '6x', p('cards.png'))
magick(p('bg_plain.png'),
       '(', p('cards.png'), '-resize', '1700x700', ')', '-gravity', 'center', '-geometry', '+0+70', '-composite',
       '-gravity', 'north',
       '-font', MONO, '-pointsize', '40', '-fill', '#9ece6a', '-annotate', '+0+60', '$ trawl render . -o out',
       '-font', INTER_B, '-pointsize', '50', '-fill', '#c0caf5', '-annotate', '+0+125',
       f'{len(outs)} diagrams  →  {len(outs)} crisp PNGs, ready for docs & slides',
       p('grid.png'))
print('grid ok')
