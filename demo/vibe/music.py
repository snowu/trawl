"""Synthesizes the vibe video's soundtrack (120 bpm, A minor), timed to the cuts in make.ts -> build/vibe/music.wav.

Standard library only: every voice is additive sines or filtered noise written into one float buffer.
"""
import array, math, os, random, struct, wave

SR = 44100
DUR = 23.5
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build', 'vibe', 'music.wav')
buf = array.array('f', bytes(4 * int(SR * DUR)))
rnd = random.Random(3)
TAU = 2 * math.pi


def add(start, samples):
    i0 = int(start * SR)
    for i, v in enumerate(samples):
        j = i0 + i
        if 0 <= j < len(buf):
            buf[j] += v


def kick(t, gain=0.7, tail=0.28):
    n = int(SR * tail * 1.6)
    ph = 0.0
    out = []
    for i in range(n):
        x = i / SR
        f = 45 + 95 * math.exp(-x * 28)
        ph += TAU * f / SR
        out.append(gain * math.sin(ph) * math.exp(-x / tail))
    add(t, out)


def noise(t, dur, gain, decay, highpass=True, rise=False):
    n = int(SR * dur)
    prev = 0.0
    out = []
    for i in range(n):
        x = i / SR
        w = rnd.uniform(-1, 1)
        v = w - prev if highpass else w
        prev = w
        env = (x / dur) ** 2 if rise else math.exp(-x / decay)
        out.append(gain * v * env)
    add(t, out)


def tone(t, freq, dur, gain, decay, harmonics=((1, 1),)):
    n = int(SR * dur)
    out = []
    for i in range(n):
        x = i / SR
        env = min(1, x / 0.004) * math.exp(-x / decay)
        out.append(gain * env * sum(a * math.sin(TAU * freq * h * x) for h, a in harmonics))
    add(t, out)


def bell(t, freq, gain=0.25):
    tone(t, freq, 2.2, gain, 0.7, ((1, 1), (2.76, 0.35), (5.4, 0.12)))


def pad(t0, t1, freqs, gain, fade=0.6):
    n0, n1 = int(t0 * SR), int(t1 * SR)
    for j in range(n0, min(n1, len(buf))):
        x = j / SR
        env = min(1, (x - t0) / fade, (t1 - x) / fade)
        lfo = 1 + 0.003 * math.sin(TAU * 5 * x)
        buf[j] += gain * env * sum(math.sin(TAU * f * lfo * x) + 0.25 * math.sin(TAU * 2 * f * x) for f in freqs) / len(freqs)


def riser(t, dur, gain=0.35):
    noise(t, dur, gain * 0.6, 1, rise=True)
    n = int(SR * dur)
    ph = 0.0
    out = []
    for i in range(n):
        x = i / SR
        ph += TAU * (200 + 1000 * (x / dur) ** 2) / SR
        out.append(gain * 0.4 * (x / dur) ** 2 * math.sin(ph))
    add(t, out)


A, C3, E, F, G = 110.0, 130.81, 164.81, 87.31, 98.0
CHORDS = [(A, (220, 261.63, 329.63)), (F, (174.61, 220, 261.63)), (C3, (261.63, 329.63, 392)), (G, (196, 246.94, 293.66))]

# Intro: a dark pad, bubbles plinking.
pad(0, 5.2, (A, C3, E, 220), 0.4, fade=1.5)
for _ in range(14):
    bell(rnd.uniform(0.2, 4.8), rnd.choice((880, 1046.5, 1318.5, 1760)), 0.05)

# Slams.
for t in (2.5, 3.25, 4.0):
    kick(t, 1.0, 0.45)
    noise(t, 0.4, 0.25, 0.12, highpass=False)

# Groove under the net, the tiles and the flowchart; a gap for the riser into the dive.
def groove(t0, t1, arps=False):
    b = t0
    while b < t1 - 1e-6:
        kick(b)
        noise(b + 0.25, 0.05, 0.22, 0.018)
        root, chord = CHORDS[int((b - 5) // 2) % 4]
        # Bass in 16ths: root, root, octave, root.
        for k, mult in enumerate((1, 1, 2, 1)):
            tone(b + k * 0.125, root * mult, 0.2, 0.22 if k == 0 else 0.14, 0.09, ((1, 1), (2, 0.5), (3, 0.25)))
        if arps:
            for k in range(4):
                tone(b + k * 0.125, chord[k % 3] * 2, 0.15, 0.06, 0.07, ((1, 1), (3, 0.1)))
        b += 0.5


for i, (root, chord) in enumerate(CHORDS * 3):
    t = 5 + i * 2
    if t < 15:
        pad(t, t + 2, chord, 0.16, fade=0.05)
groove(5, 11.0)
riser(11.0, 1.0)
kick(12.0, 1.1, 0.6)
noise(12.0, 1.2, 0.3, 0.35)
groove(12.0, 15.0, arps=True)

# check / render / open.
for t, f in ((15.0, 659.25), (15.75, 783.99), (16.5, 880.0)):
    kick(t, 1.0, 0.4)
    bell(t, f, 0.3)
    noise(t, 0.3, 0.15, 0.08)
pad(15, 17.6, (A, E, 220), 0.22)

# alt + m: hush, two clicks, an impact, a riser into the logo.
pad(17.4, 19.6, (A, C3, E), 0.22)
for t in (18.0, 18.25):
    noise(t, 0.02, 0.5, 0.004)
    tone(t, 2200, 0.03, 0.15, 0.008)
kick(18.25, 1.2, 0.8)
noise(18.25, 1.0, 0.25, 0.3, highpass=False)
riser(18.8, 0.8, 0.3)

# Logo: a big open chord and a bell.
kick(19.6, 1.0, 0.7)
pad(19.6, 23.5, (A, E, 220, 246.94, 329.63), 0.45, fade=0.9)
for k, f in enumerate((440, 659.25, 987.77)):
    bell(19.6 + k * 0.25, f, 0.2)
bell(20.4, 1318.5, 0.08)

peak = max(abs(v) for v in buf) or 1
fade_from = int((DUR - 0.8) * SR)
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    frames = bytearray()
    for j, v in enumerate(buf):
        if j > fade_from:
            v *= 1 - (j - fade_from) / (len(buf) - fade_from)
        s = int(32767 * 0.9 * math.tanh(1.2 * v / peak) / math.tanh(1.2))
        frames += struct.pack('<hh', s, s)
    w.writeframes(bytes(frames))
print(OUT)
