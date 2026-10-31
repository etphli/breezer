"""Synthesizes an original, beat-locked score for a Breezer ad.

    python3 soundtrack.py score.json out.wav

The JSON comes from the ad page (AD.audio): tempo, chord progression,
arrangement sections and sound-effect cues on the same clock as the visuals.
Everything is generated here with NumPy, so the music carries no third-party
licence.
"""

import json
import sys
import wave

import numpy as np

SR = 48000
spec = json.load(open(sys.argv[1]))
DUR = float(spec["duration"])
N = int((DUR + 2) * SR)
BPM = float(spec["bpm"])
BEAT = 60.0 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(int(BPM * 10) + len(spec["sfx"]))

buses = {name: np.zeros((2, N)) for name in ("drums", "music", "sfx", "send")}

NOTE = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6,
        "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
QUALITY = {"": [0, 4, 7, 12], "m": [0, 3, 7, 12], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11],
           "7": [0, 4, 7, 10], "sus2": [0, 2, 7, 12], "add9": [0, 4, 7, 14], "m9": [0, 3, 7, 14],
           "sus4": [0, 5, 7, 12]}


def chord(name):
    root = name[:2] if len(name) > 1 and name[1] in "#b" else name[:1]
    return NOTE[root], QUALITY[name[len(root):]]


PROG = [chord(c) for c in spec.get("progression", ["Am", "F", "C", "G"])]


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def tt(seconds):
    return np.arange(int(seconds * SR)) / SR


def add(sig, t, bus, gain=1.0, pan=0.0, send=0.0):
    i = int(round(t * SR))
    if sig.ndim == 1:
        a = (pan + 1) * np.pi / 4
        sig = np.stack([sig * np.cos(a), sig * np.sin(a)]) * np.sqrt(2)
    if i < 0:
        sig, i = sig[:, -i:], 0
    n = min(sig.shape[1], N - i)
    if n <= 0:
        return
    buses[bus][:, i:i + n] += sig[:, :n] * gain
    if send:
        buses["send"][:, i:i + n] += sig[:, :n] * gain * send


def band(noise, lo, hi):
    spectrum = np.fft.rfft(noise)
    f = np.fft.rfftfreq(len(noise), 1 / SR)
    spectrum[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(spectrum, len(noise))


def saw(f, x, harmonics, cutoff=1e9):
    out = np.zeros_like(x)
    for k in range(1, harmonics + 1):
        if f * k > 18000:
            break
        out += np.sin(2 * np.pi * f * k * x) / k * np.exp(-f * k / cutoff)
    return out


# Drums -----------------------------------------------------------------------

kicks = []


def kick(t, g=1.0):
    x = tt(0.6)
    freq = 46 + 120 * np.exp(-x / 0.03)
    body = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-x / 0.3)
    click = rng.standard_normal(len(x)) * np.exp(-x / 0.003) * 0.25
    add(np.tanh(1.8 * (body + click)) * 0.9, t, "drums", g)
    kicks.append(t)


def clap(t, g=1.0):
    x = tt(0.45)
    env = sum(np.exp(-np.clip(x - d, 0, None) / (0.012 if d < 0.02 else 0.13)) * (x >= d) for d in (0, 0.011, 0.022))
    sig = band(rng.standard_normal(len(x)), 900, 5200) * env
    add(sig * 0.5, t, "drums", g, 0, 0.35)


def hat(t, g=1.0, open_=False, pan=0.15):
    x = tt(0.3)
    sig = band(rng.standard_normal(len(x)), 7000, 16000) * np.exp(-x / (0.16 if open_ else 0.03))
    add(sig * 0.32, t, "drums", g, pan)


# Instruments -------------------------------------------------------------------

def pad(t, notes, length, bright):
    x = tt(length + 1.2)
    env = np.clip(x / 0.45, 0, 1) * np.where(x > length, np.exp(-(x - length) / 0.5), 1)
    cutoff = 350 + bright * 3200
    for j, m in enumerate(notes):
        for v, (cents, pan) in enumerate(((-9, -0.6), (0, 0), (8, 0.6))):
            f = hz(m) * 2 ** (cents / 1200)
            sig = saw(f, x + rng.random() * 0.01, 14, cutoff) * env * 0.05
            add(sig, t, "music", 1, pan, 0.55)


def bass(t, m, length, bright):
    x = tt(length + 0.1)
    f = hz(m)
    env = (1 - np.exp(-x / 0.004)) * (0.55 + 0.45 * np.exp(-x / 0.12)) * np.clip((length + 0.05 - x) / 0.05, 0, 1)
    sig = np.sin(2 * np.pi * f * x) * 0.7 + saw(f, x, 8, 300 + bright * 900) * 0.45
    add(np.tanh(1.4 * sig * env) * 0.42, t, "music", 1, 0)


def arp(t, m, pan, bright):
    x = tt(0.5)
    f = hz(m)
    sig = np.zeros_like(x)
    for k in (1, 3, 5, 7, 9):
        sig += np.sin(2 * np.pi * f * k * x) / k * np.exp(-k * f / (1200 + bright * 4000))
    add(sig * np.exp(-x / 0.14) * (1 - np.exp(-x / 0.002)) * 0.11, t, "music", 1, pan, 0.45)


# Sound effects ---------------------------------------------------------------

def sweep_noise(length, f0, f1, width=0.6):
    n = int(length * SR)
    noise = rng.standard_normal(n + 2048)
    hop, size = 512, 2048
    out = np.zeros(n + 2048)
    win = np.hanning(size)
    freqs = np.fft.rfftfreq(size, 1 / SR)
    for s in range(0, n, hop):
        p = s / n
        fc = f0 * (f1 / f0) ** p
        mask = np.exp(-(np.log2(np.maximum(freqs, 1) / fc) / width) ** 2)
        out[s:s + size] += np.fft.irfft(np.fft.rfft(noise[s:s + size] * win) * mask, size) * win
    return out[:n] / (np.max(np.abs(out[:n])) + 1e-9)


def whoosh(t, length=0.9, g=1.0, up=True, pan_from=-0.8, pan_to=0.8):
    sig = sweep_noise(length, 300 if up else 6000, 6000 if up else 300)
    p = np.linspace(0, 1, len(sig))
    env = np.sin(np.pi * np.clip(p, 0, 1) ** 0.7) ** 1.5
    left = sig * env * np.cos((np.interp(p, [0, 1], [pan_from, pan_to]) + 1) * np.pi / 4)
    right = sig * env * np.sin((np.interp(p, [0, 1], [pan_from, pan_to]) + 1) * np.pi / 4)
    add(np.stack([left, right]) * 0.55, t, "sfx", g, 0, 0.3)


def riser(t, length=2.0, g=1.0):
    sig = sweep_noise(length, 200, 9000, 0.8) * np.linspace(0, 1, int(length * SR)) ** 2.2
    x = tt(length)
    tone = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (2.5 * x / length)) / SR) * (x / length) ** 3 * 0.25
    add((sig * 0.45 + tone), t, "sfx", g, 0, 0.4)


def impact(t, g=1.0):
    x = tt(2.5)
    boom = np.sin(2 * np.pi * np.cumsum(36 + 80 * np.exp(-x / 0.05)) / SR) * np.exp(-x / 0.9)
    crash = band(rng.standard_normal(len(x)), 300, 12000) * np.exp(-x / 0.5) * 0.35
    add(np.tanh(1.6 * boom) * 0.9 + crash, t, "sfx", g, 0, 0.6)
    kicks.append(t)


def pop(t, g=1.0, pitch=1.0, pan=0.0):
    x = tt(0.15)
    f = 520 * pitch * (1 + 1.5 * np.exp(-x / 0.012))
    sig = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x / 0.05)
    add(sig * 0.45, t, "sfx", g, pan, 0.25)


def tick(t, g=1.0, pan=0.0):
    x = tt(0.05)
    sig = band(rng.standard_normal(len(x)), 2500, 12000) * np.exp(-x / 0.003) + np.sin(2 * np.pi * 3200 * x) * np.exp(-x / 0.006) * 0.4
    add(sig * 0.35, t, "sfx", g, pan)


def key(t, g=1.0):
    x = tt(0.08)
    sig = band(rng.standard_normal(len(x)), 800, 6000) * np.exp(-x / 0.008) + np.sin(2 * np.pi * (160 + rng.random() * 60) * x) * np.exp(-x / 0.02) * 0.3
    add(sig * 0.4, t, "sfx", g, rng.uniform(-0.3, 0.3))


def glitch(t, length=0.3, g=1.0):
    x = tt(length)
    seg = (x / 0.018).astype(int)
    freqs = 200 + (np.sin(seg * 91.7) * 0.5 + 0.5) * 2400
    sig = np.sign(np.sin(2 * np.pi * np.cumsum(freqs) / SR)) * 0.2
    sig = np.round(sig * 6) / 6 * (np.sin(seg * 13.1) > -0.3)
    add(sig * np.exp(-x / length * 1.5), t, "sfx", g, rng.uniform(-0.5, 0.5))


def snap(t, g=1.0, pan=0.0):
    x = tt(0.12)
    f = (1800 + rng.random() * 1800) * (1 + 0.5 * np.exp(-x / 0.01))
    sig = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x / 0.03)
    add(sig * 0.3, t, "sfx", g, pan, 0.4)


def shimmer(t, g=1.0, root=None):
    x = tt(4.0)
    r, q = PROG[0]
    base = 69 + (r - 9) if root is None else root
    sig = np.zeros_like(x)
    for i, interval in enumerate(q[:3] + [12, 19]):
        f = hz(base + interval + 12)
        for k, decay in ((1, 2.4), (2.76, 0.9), (5.4, 0.4)):
            sig += np.sin(2 * np.pi * f * k * x + i) * np.exp(-x / decay) / (k * 1.6)
    add(sig * 0.07 * (1 - np.exp(-x / 0.003)), t, "sfx", g, 0, 0.9)


def swell(t, length=1.5, g=1.0):
    sig = sweep_noise(length, 400, 4000, 1.0)
    p = np.linspace(0, 1, len(sig))
    add(sig * p ** 3 * 0.4, t, "sfx", g, 0, 0.8)


def sub(t, g=1.0):
    x = tt(1.6)
    sig = np.sin(2 * np.pi * np.cumsum(55 * 2 ** (-x * 0.9)) / SR) * np.exp(-x / 0.7)
    add(np.tanh(2 * sig) * 0.8, t, "sfx", g)


SFX = {"whoosh": whoosh, "riser": riser, "impact": impact, "pop": pop, "tick": tick, "key": key,
       "glitch": glitch, "snap": snap, "shimmer": shimmer, "swell": swell, "sub": sub, "kick": kick,
       "clap": clap}

# Arrangement -----------------------------------------------------------------

for sec in spec["sections"]:
    start, end = sec["from"], sec["to"]
    bright = sec.get("bright", 0.5)
    b0 = int(np.ceil(start / BEAT - 1e-6))
    b1 = int(np.floor(end / BEAT - 1e-6))
    for b in range(b0, b1 + 1):
        tb = b * BEAT
        if tb >= end:
            break
        root, quality = PROG[int(tb // BAR) % len(PROG)]
        k = sec.get("kick")
        if k == "four" or (k == "half" and b % 2 == 0):
            kick(tb)
        if sec.get("clap") and b % 4 in (1, 3):
            clap(tb)
        hats = sec.get("hats")
        if hats == "8":
            hat(tb + BEAT / 2, 1, b % 4 == 3)
        if hats == "16":
            for s in range(4):
                hat(tb + s * BEAT / 4, 0.55 + 0.45 * (s == 2), s == 2 and b % 2 == 1, 0.25 * (-1) ** s)
        if sec.get("bass"):
            pattern = (0, 0.5) if sec["bass"] == "8" else (0,)
            for off in pattern:
                if tb + off * BEAT < end:
                    bass(tb + off * BEAT, 33 + root + (12 if off and b % 2 else 0), BEAT * (0.45 if len(pattern) > 1 else 0.9), bright)
        if sec.get("arp"):
            tones = [57 + root + q for q in quality] + [69 + root + quality[1]]
            for s in range(4):
                if tb + s * BEAT / 4 < end:
                    arp(tb + s * BEAT / 4, tones[(b * 4 + s) % len(tones)], 0.45 * (-1) ** s, bright)
        if sec.get("pad") and (b % 4 == 0 or b == b0):
            length = min(BAR - (tb % BAR), end - tb)
            pad(tb, [45 + root + 12 + q for q in quality], length, bright)

for cue in spec["sfx"]:
    opts = {k: v for k, v in cue.items() if k not in ("t", "type")}
    SFX[cue["type"]](cue["t"], **opts)

# Mix -------------------------------------------------------------------------

x = np.arange(N) / SR
duck = np.ones(N)
for k in kicks:
    i = int(k * SR)
    seg = x[i:i + SR] - k
    duck[i:i + SR] = np.minimum(duck[i:i + SR], 1 - 0.6 * np.exp(-seg / 0.14))

ir_len = int(2.4 * SR)
ir_x = np.arange(ir_len) / SR
reverb = np.zeros((2, N))
size = 1 << int(np.ceil(np.log2(N + ir_len)))
for ch in range(2):
    ir = rng.standard_normal(ir_len) * np.exp(-ir_x / 0.75) * (1 - np.exp(-ir_x / 0.01))
    ir = band(ir, 200, 9000)
    wet = np.fft.irfft(np.fft.rfft(buses["send"][ch], size) * np.fft.rfft(ir, size), size)[:N]
    reverb[ch] = wet / (np.max(np.abs(wet)) + 1e-9)

mix = buses["drums"] * 0.95 + buses["music"] * duck * 0.8 + buses["sfx"] * 0.95 + reverb * 0.22
mix -= mix.mean(axis=1, keepdims=True)
mix = np.tanh(mix * 1.15)
mix = mix[:, :int(DUR * SR)]
fade = int(0.25 * SR)
mix[:, -fade:] *= np.linspace(1, 0, fade)
mix[:, :240] *= np.linspace(0, 1, 240)
mix *= 0.7 / (np.max(np.abs(mix)) + 1e-9)

with wave.open(sys.argv[2], "wb") as out:
    out.setnchannels(2)
    out.setsampwidth(2)
    out.setframerate(SR)
    out.writeframes((mix.T * 32767).astype("<i2").tobytes())
