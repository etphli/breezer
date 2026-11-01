"""Scores and mixes a voiced Breezer ad.

    FFMPEG=/path/to/ffmpeg python3 premium_score.py score.json out.wav

The JSON comes from the ad page (AD.audio with engine "premium"): tempo,
chords, arrangement sections, sound cues and the voice-over edit. The music is
synthesized here. The voice is cut into phrases, re-spaced to the ad's timeline,
processed like a broadcast read, and the music ducks underneath it. The master is
normalized to -16 LUFS integrated with a -1.5 dBTP ceiling.
"""

import json
import os
import subprocess
import sys
import wave

import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d

SR = 48000
spec = json.load(open(sys.argv[1]))
DUR = float(spec["duration"])
N = int((DUR + 3) * SR)
BPM = float(spec["bpm"])
BEAT = 60.0 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(int(BPM * 100) + int(DUR))
here = os.path.dirname(os.path.abspath(__file__))

bus = {k: np.zeros((2, N)) for k in ("music", "fx", "send", "voice")}

NOTE = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6,
        "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
QUAL = {"": [0, 4, 7], "m": [0, 3, 7], "maj7": [0, 4, 7, 11], "m7": [0, 3, 7, 10], "add9": [0, 4, 7, 14],
        "m9": [0, 3, 7, 14], "sus2": [0, 2, 7], "sus4": [0, 5, 7], "6": [0, 4, 7, 9], "maj9": [0, 4, 7, 11, 14]}


def chord(name):
    root = name[:2] if len(name) > 1 and name[1] in "#b" else name[:1]
    return NOTE[root], QUAL[name[len(root):]]


PROG = [chord(c) for c in spec["progression"]]


def chord_at(t):
    return PROG[int(t // BAR) % len(PROG)]


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tt(sec):
    return np.arange(int(sec * SR)) / SR


def place(sig, t, name, gain=1.0, pan=0.0, send=0.0):
    if sig.ndim == 1:
        a = (np.clip(pan, -1, 1) + 1) * np.pi / 4
        sig = np.stack([sig * np.cos(a), sig * np.sin(a)]) * np.sqrt(2)
    i = int(round(t * SR))
    if i < 0:
        sig, i = sig[:, -i:], 0
    n = min(sig.shape[1], N - i)
    if n <= 0:
        return
    bus[name][:, i:i + n] += sig[:, :n] * gain
    if send:
        bus["send"][:, i:i + n] += sig[:, :n] * gain * send


def biquad(kind, f, q=0.707, gain_db=0.0):
    """RBJ cookbook biquad as second-order sections."""
    a = 10 ** (gain_db / 40)
    w = 2 * np.pi * f / SR
    cw, sw = np.cos(w), np.sin(w)
    al = sw / (2 * q)
    if kind == "peak":
        b = [1 + al * a, -2 * cw, 1 - al * a]
        d = [1 + al / a, -2 * cw, 1 - al / a]
    elif kind in ("lowshelf", "highshelf"):
        s = 1 if kind == "lowshelf" else -1
        sq = 2 * np.sqrt(a) * al
        b = [a * ((a + 1) - s * (a - 1) * cw + sq), s * 2 * a * ((a - 1) - s * (a + 1) * cw), a * ((a + 1) - s * (a - 1) * cw - sq)]
        d = [(a + 1) + s * (a - 1) * cw + sq, -s * 2 * ((a - 1) + s * (a + 1) * cw), (a + 1) + s * (a - 1) * cw - sq]
    else:
        raise ValueError(kind)
    b, d = np.array(b) / d[0], np.array(d) / d[0]
    return np.concatenate([b, d])[None, :]


def lowpass_sweep(x, f0, f1, q=0.9, block=1024):
    """Resonant low-pass whose cutoff glides from f0 to f1 across the signal."""
    out = np.zeros_like(x)
    zi = np.zeros((1, 2))
    n = len(x)
    for s in range(0, n, block):
        p = s / max(1, n - 1)
        f = min(f0 * (f1 / f0) ** p, SR * 0.45)
        sos = signal.butter(2, f, "low", fs=SR, output="sos")
        out[s:s + block], zi = signal.sosfilt(sos, x[s:s + block], zi=zi)
    return out


def saw(f, x):
    # Band-limited sawtooth from sines.
    out = np.zeros_like(x)
    for k in range(1, int(min(40, 16000 / f)) + 1):
        out += np.sin(2 * np.pi * f * k * x) / k
    return out


# Instruments -----------------------------------------------------------------

def pad(t0, t1, notes, bright, level=1.0):
    length = t1 - t0
    x = tt(length + 2.0)
    env = np.clip(x / 0.9, 0, 1) ** 1.5 * np.where(x > length, np.exp(-(x - length) / 0.9), 1)
    left = np.zeros_like(x)
    right = np.zeros_like(x)
    for m in notes:
        for cents, side in ((-7, 0), (-2, 1), (3, 0), (8, 1)):
            f = hz(m) * 2 ** (cents / 1200)
            v = saw(f, x + rng.random() * 0.02)
            (left if side == 0 else right)[:] += v
    cut0 = 300 + bright * 1200
    cut1 = 500 + bright * 3800
    left = lowpass_sweep(left, cut0, cut1)
    right = lowpass_sweep(right, cut0 * 1.05, cut1 * 0.95)
    sig = np.stack([left, right]) * env * 0.022 * level / max(1, len(notes) / 3)
    place(sig, t0, "music", 1, 0, 0.6)


def piano(t, m, vel=0.7, pan=None):
    f = hz(m)
    x = tt(5.0)
    B = 0.00035
    sig = np.zeros_like(x)
    for n in range(1, 14):
        fn = f * n * np.sqrt(1 + B * n * n)
        if fn > 16000:
            break
        decay = (3.2 - 0.12 * (m - 60) / 12) / (1 + 0.35 * n)
        amp = (1 / n ** 1.15) * (0.6 + 0.4 * vel ** (n * 0.3))
        sig += amp * np.sin(2 * np.pi * fn * x + rng.random()) * np.exp(-x / max(0.15, decay))
    hammer = signal.sosfilt(signal.butter(2, [800, 5000], "band", fs=SR, output="sos"), rng.standard_normal(len(x))) * np.exp(-x / 0.004) * 0.15
    sig = (sig * (1 - np.exp(-x / 0.0015)) + hammer) * vel * 0.16
    place(sig, t, "music", 1, (m - 64) / 30 if pan is None else pan, 0.55)


def pluck(t, m, length, pan, bright):
    x = tt(length + 0.3)
    v = saw(hz(m), x) * np.exp(-x / (0.12 + bright * 0.1)) * (1 - np.exp(-x / 0.002))
    v = signal.sosfilt(signal.butter(2, 900 + bright * 2500, "low", fs=SR, output="sos"), v)
    place(v * 0.12, t, "music", 1, pan, 0.4)


def sub_bass(t, m, length):
    x = tt(length + 0.2)
    env = np.clip(x / 0.02, 0, 1) * np.clip((length + 0.15 - x) / 0.15, 0, 1)
    v = np.sin(2 * np.pi * hz(m) * x) + 0.18 * np.sin(4 * np.pi * hz(m) * x)
    place(np.tanh(1.3 * v) * env * 0.3, t, "music")


def kick(t, g=1.0):
    x = tt(0.7)
    f = 42 + 95 * np.exp(-x / 0.028)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x / 0.32)
    click = signal.sosfilt(signal.butter(2, 3000, "high", fs=SR, output="sos"), rng.standard_normal(len(x))) * np.exp(-x / 0.002) * 0.12
    place(np.tanh(1.4 * body + click) * 0.75 * g, t, "fx")
    kicks.append(t)


def hat(t, g=1.0, pan=0.2):
    x = tt(0.15)
    v = signal.sosfilt(signal.butter(4, 8000, "high", fs=SR, output="sos"), rng.standard_normal(len(x))) * np.exp(-x / 0.025)
    place(v * 0.09 * g, t, "fx", 1, pan, 0.1)


def snap(t, g=1.0):
    x = tt(0.4)
    v = signal.sosfilt(signal.butter(2, [1200, 6000], "band", fs=SR, output="sos"), rng.standard_normal(len(x)))
    env = sum((x >= d) * np.exp(-np.clip(x - d, 0, None) / (0.008 if d < 0.02 else 0.09)) for d in (0, 0.009, 0.018))
    place(v * env * 0.22 * g, t, "fx", 1, 0, 0.45)


def boom(t, g=1.0):
    x = tt(4.0)
    sub = np.sin(2 * np.pi * np.cumsum(32 + 60 * np.exp(-x / 0.08)) / SR) * np.exp(-x / 1.4)
    body = signal.sosfilt(signal.butter(2, 400, "low", fs=SR, output="sos"), rng.standard_normal(len(x))) * np.exp(-x / 0.35) * 0.5
    air = signal.sosfilt(signal.butter(2, 2000, "high", fs=SR, output="sos"), rng.standard_normal(len(x))) * np.exp(-x / 0.9) * 0.08
    place(np.tanh(1.5 * sub) * 0.85 * g + body * g, t, "fx", 1, 0, 0.3)
    place(air * g, t, "fx", 1, 0, 0.8)
    kicks.append(t)


def noise_sweep(length, f0, f1, width=0.5):
    n = int(length * SR)
    size, hop = 2048, 512
    src = rng.standard_normal(n + size)
    out = np.zeros(n + size)
    win = np.hanning(size)
    freqs = np.fft.rfftfreq(size, 1 / SR)
    for s in range(0, n, hop):
        fc = f0 * (f1 / f0) ** (s / n)
        mask = np.exp(-(np.log2(np.maximum(freqs, 1) / fc) / width) ** 2)
        out[s:s + size] += np.fft.irfft(np.fft.rfft(src[s:s + size] * win) * mask, size) * win
    out = out[:n]
    return out / (np.max(np.abs(out)) + 1e-9)


def whoosh(t, length=1.2, g=1.0, pan_from=-0.7, pan_to=0.7, up=True):
    v = noise_sweep(length, 250 if up else 5000, 5000 if up else 250, 0.7)
    p = np.linspace(0, 1, len(v))
    env = np.sin(np.pi * p ** 0.75) ** 2
    pan = np.interp(p, [0, 1], [pan_from, pan_to])
    a = (pan + 1) * np.pi / 4
    place(np.stack([v * env * np.cos(a), v * env * np.sin(a)]) * 0.4 * np.sqrt(2), t, "fx", g, 0, 0.35)


def riser(t, length=2.5, g=1.0):
    v = noise_sweep(length, 300, 9000, 0.9) * np.linspace(0, 1, int(length * SR)) ** 2.5
    root, q = chord_at(t + length)
    x = tt(length)
    tone = sum(np.sin(2 * np.pi * hz(57 + root + i) * (1 + 0.5 * (x / length) ** 3) * x) for i in q[:3]) * (x / length) ** 3 * 0.05
    v = signal.sosfilt(signal.butter(2, 700, "high", fs=SR, output="sos"), v)
    place(v * 0.11 + tone, t, "fx", g, 0, 0.6)


def air(t0, t1, level=1.0):
    """The breeze: slowly moving band-passed noise, wide and soft."""
    length = t1 - t0
    n = int(length * SR)
    out = np.zeros((2, n))
    for ch in range(2):
        src = rng.standard_normal(n)
        pink = signal.sosfilt(signal.butter(1, 900, "low", fs=SR, output="sos"), src)
        lfo = 0.5 + 0.5 * np.sin(2 * np.pi * np.arange(n) / SR * (0.13 + ch * 0.04) + ch)
        sweep = lowpass_sweep(pink, 600, 1800) * (0.4 + 0.6 * lfo)
        out[ch] = sweep
    fade = np.minimum(1, np.minimum(np.arange(n) / (1.5 * SR), (n - np.arange(n)) / (1.5 * SR)))
    out *= fade / (np.max(np.abs(out)) + 1e-9) * 0.14 * level
    place(out, t0, "fx", 1, 0, 0.2)


def shimmer(t, g=1.0, octave=1):
    root, q = chord_at(t)
    x = tt(6.0)
    v = np.zeros_like(x)
    for i, iv in enumerate(q[:3] + [12]):
        f = hz(60 + root + iv + 12 * octave)
        for k, d in ((1, 3.0), (2.0, 1.4), (3.01, 0.6)):
            v += np.sin(2 * np.pi * f * k * x + i) * np.exp(-x / d) / (k * 2)
    place(v * 0.035 * g * (1 - np.exp(-x / 0.004)), t, "fx", 1, 0, 0.9)


def tick(t, g=1.0, pan=0.0):
    x = tt(0.06)
    v = np.sin(2 * np.pi * 2400 * x) * np.exp(-x / 0.006) + signal.sosfilt(signal.butter(2, 4000, "high", fs=SR, output="sos"), rng.standard_normal(len(x))) * np.exp(-x / 0.002) * 0.4
    place(v * 0.12 * g, t, "fx", 1, pan, 0.3)


def glass(t, g=1.0, pitch=84):
    x = tt(3.0)
    f = hz(pitch)
    v = sum(np.sin(2 * np.pi * f * k * x) * np.exp(-x / d) / k for k, d in ((1, 1.6), (2.76, 0.5), (5.4, 0.2), (8.9, 0.08)))
    place(v * 0.05 * g * (1 - np.exp(-x / 0.001)), t, "fx", 1, 0, 0.7)


def heartbeat(t, g=1.0):
    for d, a in ((0, 1), (0.22, 0.7)):
        x = tt(0.4)
        v = np.sin(2 * np.pi * np.cumsum(55 + 30 * np.exp(-x / 0.02)) / SR) * np.exp(-x / 0.12)
        place(v * 0.5 * a * g, t + d, "fx")


def drone(t0, t1, m, level=1.0):
    x = tt(t1 - t0)
    env = np.minimum(1, np.minimum(x / 2.0, (t1 - t0 - x) / 1.5))
    v = sum(np.sin(2 * np.pi * hz(m) * k * x * (1 + 0.0007 * np.sin(x * 0.7 * k))) / k ** 1.5 for k in (1, 2, 3, 5))
    place(v * env * 0.08 * level, t0, "music", 1, 0, 0.4)


kicks = []
SFX = {"whoosh": whoosh, "riser": riser, "boom": boom, "shimmer": shimmer, "tick": tick, "glass": glass,
       "heartbeat": heartbeat, "kick": kick, "snap": snap, "air": lambda t, length=4, level=1: air(t, t + length, level)}

# Arrangement -------------------------------------------------------------------

for sec in spec["sections"]:
    t0, t1 = sec["from"], sec["to"]
    bright = sec.get("bright", 0.5)
    if "pad" in sec:
        t = t0
        while t < t1 - 0.05:
            nb = min(t1, (np.floor(t / BAR + 1e-6) + 1) * BAR)
            root, q = chord_at(t)
            pad(t, nb, [48 + root + iv for iv in q] + [36 + root], bright, sec["pad"])
            t = nb
    if "drone" in sec:
        drone(t0, t1, 36 + PROG[0][0], sec["drone"])
    if "air" in sec:
        air(t0, t1, sec["air"])
    b0 = int(np.ceil(t0 / BEAT - 1e-6))
    b = b0
    while b * BEAT < t1 - 1e-6:
        tb = b * BEAT
        root, q = chord_at(tb)
        bi = b % 4
        k = sec.get("kick")
        if k == "four" or (k == "half" and bi in (0, 2)) or (k == "one" and bi == 0):
            kick(tb, sec.get("kickGain", 0.8))
        if sec.get("snap") and bi in (1, 3):
            snap(tb, 0.7)
        if sec.get("hats"):
            hat(tb + BEAT / 2, 0.8, 0.3)
            if sec["hats"] == "16":
                hat(tb + BEAT / 4, 0.4, -0.3)
                hat(tb + 3 * BEAT / 4, 0.4, -0.3)
        if sec.get("bass"):
            sub_bass(tb, 36 + root - (12 if root > 6 else 0) + 12, BEAT * 0.9)
        if sec.get("pulse"):
            tones = [60 + root + iv for iv in q]
            for s in range(2):
                if tb + s * BEAT / 2 < t1:
                    pluck(tb + s * BEAT / 2, tones[(b * 2 + s) % len(tones)], BEAT / 2, 0.4 * (-1) ** s, bright)
        if sec.get("piano"):
            pattern = {0: 0, 1.5: 1, 2.5: 2, 3: 3} if sec["piano"] == "motif" else {0: 0}
            for off, idx in pattern.items():
                if int(off) == bi and tb + (off - bi) * BEAT < t1:
                    tones = [60 + root + iv for iv in q] + [72 + root]
                    piano(tb + (off - bi) * BEAT, tones[idx % len(tones)], 0.55 + 0.2 * (idx == 0))
                    if idx == 0:
                        piano(tb, 48 + root, 0.45)
        b += 1

for cue in spec.get("sfx", []):
    opts = {k: v for k, v in cue.items() if k not in ("t", "type")}
    SFX[cue["type"]](cue["t"], **opts)

# Voice -------------------------------------------------------------------------

voice_env = np.zeros(N)
if spec.get("voice"):
    vo = spec["voice"]
    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
    raw = subprocess.run([ffmpeg, "-loglevel", "error", "-i", os.path.join(here, vo["file"]), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                         check=True, capture_output=True).stdout
    src = np.frombuffer(raw, dtype="<f4").astype(np.float64)
    # Broadcast chain: clean lows, less mud, more presence and air.
    src = signal.sosfilt(signal.butter(2, 85, "high", fs=SR, output="sos"), src)
    for sos in (biquad("peak", 280, 1.1, -2.0), biquad("peak", 3300, 0.9, 2.5), biquad("highshelf", 9500, 0.7, 2.0), biquad("lowshelf", 140, 0.7, 1.0)):
        src = signal.sosfilt(sos, src)
    # Gentle de-esser on 6-9 kHz.
    ess = signal.sosfilt(signal.butter(2, [5800, 9500], "band", fs=SR, output="sos"), src)
    ess_env = signal.sosfilt(signal.butter(1, 60, "low", fs=SR, output="sos"), np.abs(ess))
    src = src - ess * np.clip((ess_env - 0.02) / 0.05, 0, 0.5)
    # Compressor: 3:1 above -22 dBFS, 4 ms attack, 140 ms release.
    level = np.abs(src)
    env = np.zeros_like(level)
    att, rel = np.exp(-1 / (0.004 * SR)), np.exp(-1 / (0.14 * SR))
    e = 0.0
    for i in range(0, len(level), 32):
        v = level[i:i + 32].max()
        e = att * e + (1 - att) * v if v > e else rel * e + (1 - rel) * v
        env[i:i + 32] = e
    db = 20 * np.log10(env + 1e-9)
    gain_db = np.where(db > -22, (-22 - db) * (1 - 1 / 3), 0)
    src = src * 10 ** (gain_db / 20)
    src *= 0.5 / (np.max(np.abs(src)) + 1e-9)
    fade = int(0.012 * SR)
    win = int(0.01 * SR)
    rms = np.sqrt(np.convolve(src ** 2, np.ones(win) / win, mode="same"))

    def quietest(at, reach=0.07):
        lo, hi = max(0, int((at - reach) * SR)), min(len(src) - 1, int((at + reach) * SR))
        return (lo + int(np.argmin(rms[lo:hi + 1]))) / SR if hi > lo else at

    for seg in vo["segments"]:
        start = quietest(seg["from"]) if seg["from"] > 0.02 else seg["from"]
        end = quietest(seg["to"])
        seg = {"from": start, "to": end, "at": seg["at"] + (start - seg["from"])}
        a, b = int(seg["from"] * SR), int(seg["to"] * SR)
        piece = src[a:b].copy()
        piece[:fade] *= np.linspace(0, 1, fade)
        piece[-fade:] *= np.linspace(1, 0, fade)
        place(piece, seg["at"], "voice", 1, 0, 0.05)
        i = int(seg["at"] * SR)
        voice_env[i:i + len(piece)] = np.maximum(voice_env[i:i + len(piece)], 1)
    # Smooth the ducking envelope: quick to dip, slow to recover.
    smooth = np.zeros(N)
    e = 0.0
    att, rel = np.exp(-1 / (0.06 * SR)), np.exp(-1 / (0.5 * SR))
    for i in range(0, N, 64):
        v = voice_env[i]
        e = att * e + (1 - att) * v if v > e else rel * e + (1 - rel) * v
        smooth[i:i + 64] = e
    voice_env = smooth

# Mix ---------------------------------------------------------------------------

x = np.arange(N) / SR
duck_k = np.ones(N)
for k in kicks:
    i = int(k * SR)
    seg = x[i:i + SR // 2] - k
    duck_k[i:i + SR // 2] = np.minimum(duck_k[i:i + SR // 2], 1 - 0.35 * np.exp(-seg / 0.16))
duck_v = 1 - float(spec.get("voice", {}).get("duck", 0.55)) * voice_env


def reverb_ir(seconds, seed):
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    xi = np.arange(n) / SR
    ir = np.zeros(n)
    for (lo, hi), decay in (((60, 500), seconds * 0.38), ((500, 3000), seconds * 0.3), ((3000, 14000), seconds * 0.16)):
        ir += signal.sosfilt(signal.butter(2, [lo, hi], "band", fs=SR, output="sos"), r.standard_normal(n)) * np.exp(-xi / decay)
    pre = int(0.022 * SR)
    return np.concatenate([np.zeros(pre), ir * (1 - np.exp(-xi / 0.008))])


verb = np.zeros((2, N))
for ch in range(2):
    wet = signal.fftconvolve(bus["send"][ch], reverb_ir(3.2, 11 + ch))[:N]
    verb[ch] = wet / (np.max(np.abs(wet)) + 1e-9)

music = bus["music"] * duck_k * duck_v
fx = bus["fx"] * (1 - 0.35 * voice_env)
mix = music * 0.9 + fx * 0.9 + verb * 0.16 * (1 - 0.4 * voice_env) + bus["voice"] * 1.6
mix = signal.sosfilt(signal.butter(2, 25, "high", fs=SR, output="sos"), mix, axis=1)
mix = mix[:, :int(DUR * SR)]
tail = int(0.8 * SR)
mix[:, -tail:] *= np.linspace(1, 0, tail) ** 2


def loudness(y):
    """Integrated loudness per ITU-R BS.1770 with gating."""
    pre = biquad("highshelf", 1681, 0.7071, 4.0)
    rlb = signal.butter(2, 38, "high", fs=SR, output="sos")
    k = signal.sosfilt(rlb, signal.sosfilt(pre, y, axis=1), axis=1)
    block, hop = int(0.4 * SR), int(0.1 * SR)
    ms = np.array([np.mean(k[:, s:s + block] ** 2, axis=1).sum() for s in range(0, k.shape[1] - block, hop)])
    lk = -0.691 + 10 * np.log10(ms + 1e-12)
    ms = ms[lk > -70]
    rel = -0.691 + 10 * np.log10(ms.mean()) - 10
    ms = ms[(-0.691 + 10 * np.log10(ms + 1e-12)) > rel]
    return -0.691 + 10 * np.log10(ms.mean())


# Aim 1 dB hot: this K-weighting reads about 1 LU above ffmpeg's EBU R128 meter.
target = float(spec.get("lufs", -16)) + 1.0
for _ in range(2):
    mix *= 10 ** ((target - loudness(mix)) / 20)
    # True-peak limiter: 4x oversampled peak detection, smooth gain reduction.
    over = signal.resample_poly(mix, 4, 1, axis=1)
    peak = np.abs(over).max(axis=0).reshape(-1, 4).max(axis=1)[:mix.shape[1]]
    ceiling = 10 ** (-1.5 / 20)
    need = np.minimum(1, ceiling / np.maximum(peak, 1e-9))
    # Hold each reduction 5 ms either side, then release over about 80 ms.
    need = minimum_filter1d(need, int(0.01 * SR) + 1)
    step = 16
    blocks = need[: len(need) // step * step].reshape(-1, step).min(axis=1)
    g = np.ones_like(blocks)
    e = 1.0
    rel = np.exp(-step / (0.08 * SR))
    for i, v in enumerate(blocks):
        e = v if v < e else rel * e + (1 - rel) * v
        g[i] = e
    g = np.concatenate([np.repeat(g, step), np.full(len(need) - len(g) * step, g[-1])])
    mix *= signal.sosfiltfilt(signal.butter(1, 200, "low", fs=SR, output="sos"), g)

print(f"loudness {loudness(mix):.1f} LUFS, peak {20 * np.log10(np.abs(signal.resample_poly(mix, 4, 1, axis=1)).max()):.1f} dBTP")

with wave.open(sys.argv[2], "wb") as out:
    out.setnchannels(2)
    out.setsampwidth(2)
    out.setframerate(SR)
    out.writeframes((np.clip(mix.T, -1, 1) * 32767).astype("<i2").tobytes())
