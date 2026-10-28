"""Drives a real bash + trawl in a pty inside this terminal, typing like a human, and logs caption times.

Runs inside the recorded Ghostty window: child output goes straight to the terminal (so kitty graphics images
render for real) and terminal replies (cell-size query) go back to the child.
"""
import fcntl, json, os, pty, random, select, struct, sys, termios, threading, time, tty

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, '..', 'build', 'tui')
GO, DONE, TIMELINE = (os.path.join(BUILD, n) for n in ('go', 'done', 'timeline.json'))

cols, rows = os.get_terminal_size(sys.stdout.fileno())
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.path.join(BUILD, 'shop'))
    os.execvp('bash', ['bash', '--noprofile', '--rcfile', os.path.join(HERE, 'demo.rc'), '-i'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

out_log = bytearray()
captions = []
t0 = None
lock = threading.Lock()


def pump():
    """Child -> terminal, terminal -> child."""
    stdin = sys.stdin.fileno()
    while True:
        r, _, _ = select.select([fd, stdin], [], [], 0.05)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            os.write(sys.stdout.fileno(), data)
            with lock:
                out_log.extend(data)
        if stdin in r:
            os.write(fd, os.read(stdin, 4096))


def send(b):
    os.write(fd, b if isinstance(b, bytes) else b.encode())


def wait(s):
    time.sleep(s)


def caption(text, dur=1.6):
    captions.append({'t': time.time(), 'text': text, 'dur': dur})


def type_(text, cps=16):
    for ch in text:
        send(ch)
        time.sleep(random.uniform(0.6, 1.4) / cps)


def wait_for(needle, timeout=10):
    end = time.time() + timeout
    start = len(out_log)
    while time.time() < end:
        with lock:
            if needle in out_log[start:]:
                return
        time.sleep(0.03)


def mouse(code, col, row, release=False):
    send(f'\x1b[<{code};{col};{row}{"m" if release else "M"}')


tty.setraw(sys.stdin.fileno())
sys.stdout.write('\x1b[?25l\x1b[2J\x1b[H')
sys.stdout.flush()
threading.Thread(target=pump, daemon=True).start()

while not os.path.exists(GO):
    time.sleep(0.02)
t0 = time.time()
wait(0.8)

UP, DOWN, RIGHT, LEFT, ESC = '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b'
# Preview pane centre: the list takes roughly the left third.
img_col, img_row = int(cols * 0.68), rows // 2

# 1. Lint
caption('trawl check  ·  lint every diagram in the repo', 2.4)
type_('trawl check .')
wait(0.3)
send('\r')
wait(1.9)

# 2. Picker via the keybind
send('\x0c')  # ctrl-l
wait(0.4)
caption('alt + m  ·  picker from any prompt', 1.9)
send('\x1bm')
wait_for(b'1049h')
wait(1.7)

# 3. Browse: real renders, every diagram type
caption('↑ ↓  ·  real rendered previews', 2.4)
for d in (0.85, 0.8, 0.8):
    send(DOWN)
    wait(d)
caption('← →  ·  jump between folders', 3.6)
for _ in range(4):
    send(RIGHT)
    wait(0.9)
send(DOWN)
wait(0.9)

# 4. Filter, zoom, pan
caption('type to filter', 1.6)
type_('platform', 11)
wait(1.1)
caption('scroll  ·  zoom in', 1.6)
# The platform diagram is wide, so it sits in the top rows of the pane.
zoom_row = 7
for _ in range(4):
    mouse(64, img_col + 4, zoom_row)
    wait(0.26)
wait(0.5)
caption('drag  ·  pan', 1.5)
mouse(0, img_col, zoom_row)
for i in range(1, 13):
    mouse(32, img_col + i * 2, zoom_row + (i // 3))
    wait(0.06)
mouse(0, img_col + 24, zoom_row + 4, release=True)
wait(0.9)
caption('right-click  ·  reset', 1.0)
mouse(2, img_col, zoom_row)
mouse(2, img_col, zoom_row, release=True)
wait(1.0)

# 5. Source view
caption('ctrl + t  ·  peek at the source', 1.9)
send('\x14')
wait(1.9)
send('\x14')
wait(0.5)

# 6. Mark several
send(ESC)
wait(0.5)
caption('tab  ·  mark several to open together', 2.2)
for _ in range(3):
    send('\t')
    wait(0.55)
wait(0.6)

# 7. Quit, export
send(ESC)
wait(0.6)
caption('trawl render  ·  export every diagram as PNG / SVG', 3.0)
type_('trawl render . -o out && ls out')
wait(0.3)
send('\r')
wait(3.2)

with open(TIMELINE, 'w') as f:
    json.dump({'t0': t0, 'captions': captions}, f, indent=1)
open(DONE, 'w').close()
wait(30)
