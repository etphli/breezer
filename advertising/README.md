# Breezer ads

Eight spots, all 1920×1080 at 30 fps with stereo sound. Five 30-second ads are
cut to music. Three longer ads carry a voice-over in the style of a product film.

## Voiced ads

| File | Length | Idea | Closing line |
| --- | --- | --- | --- |
| [breezer-06-air.mp4](breezer-06-air.mp4) | 52 s | Brand film. Silk ribbons of light tangle as tabs, pop-ups, spinners and watching eyes pile up in 3D. A gust clears them on "got out of the way", then the ribbons gather into the logo and the product tour. | The web, without the weight. |
| [breezer-07-unseen.mp4](breezer-07-unseen.mp4) | 41 s | Privacy. Trackers light up across a field of pages and network into a constellation. "It isn't." lands on a cut to black, then a shockwave clears every tracker and later ones bounce off. | Browse unwatched. |
| [breezer-08-light.mp4](breezer-08-light.mp4) | 40 s | Bloat-free, in a bright studio. An overloaded browser sits heavy on the floor. Each kind of bloat lifts away as it is named, and the window rises as it gets lighter until it dissolves into light. | Fast. Light. Private. |

The voice is ElevenLabs' "Brian" voice on Eleven v4, generated from a free
account. ElevenLabs' free plan does not grant commercial use, so move to a paid
plan before running these as paid ads. Each script was read in one take. The
render cuts it at natural pauses, re-spaces the phrases, and times every caption
and visual cue to ElevenLabs' word timings. The takes and their timings are in
`src/voice/`.

These renders blend two sub-frames per frame for motion blur and use GPU
shaders for light and atmosphere. The mix applies a broadcast voice chain and
ducks the music under the voice, mastered to -16 LUFS with a -1.5 dBTP ceiling.

## Music-driven ads

| File | Idea | Closing line |
| --- | --- | --- |
| [breezer-01-blink.mp4](breezer-01-blink.mp4) | A loading spinner gives way to a beat-cut run of instant actions and a browser that fills with tabs and pages on the beat. | The web, at the speed of you. |
| [breezer-02-unclutter.mp4](breezer-02-unclutter.mp4) | A browser buries itself in pop-ups, upsells and sponsored tiles, then a gust blows it all away to reveal Breezer. | Bloat-free, by design. |
| [breezer-03-unwatched.mp4](breezer-03-unwatched.mp4) | A cursor collects a swarm of trackers until a shockwave snaps every string. Later ones bounce off its shield. | Browse unwatched. |
| [breezer-04-less.mp4](breezer-04-less.mp4) | A kinetic-type manifesto ("Less waiting. Less weight. Less watching. More web.") followed by a montage of real Breezer screens. | The web, without the weight. |
| [breezer-05-tailwind.mp4](breezer-05-tailwind.mp4) | A jump to warp speed with websites streaming past, ending as a portal that opens into Breezer. | Catch the breeze. |

The five 30-second ads end on the same card: logo, wordmark, the three pillars (fast,
bloat-free, private) and the download address.

## Music and sound

The music and sound effects are original. `src/soundtrack.py` (30-second ads)
and `src/premium_score.py` (voiced ads) synthesize them from each ad's own
timeline, so drums, risers, impacts and whooshes land on the same frames as the
cuts. Apart from the ElevenLabs voice, no third-party audio is used.

## Claims

The copy uses speed language ("Built for speed", "No spinners. No waiting.")
but not "the fastest browser". Breezer's own benchmarks in `build/` do not yet
show it beating Chrome on startup or page readiness, so a superlative would
not be supportable. Add one only after a completed benchmark backs it up. The
privacy lines rely on Helium's bundled uBlock Origin and the
ungoogled-chromium base, which strips Google's telemetry.

## Editing and rendering

Each ad is a single HTML page in `src/`. Open it in Chrome to watch it loop,
or add `?t=12.5` to the URL to hold one frame. Every visual is a pure function
of time, so frames render identically each time.

Rendering needs Google Chrome, Node 22, Python 3 with NumPy and SciPy,
[`playwright-core`](https://www.npmjs.com/package/playwright-core) and an
ffmpeg build that includes libx264:

```sh
AD_TOOLS=/path/to/tools node advertising/src/render.mjs          # all eight
AD_TOOLS=/path/to/tools node advertising/src/render.mjs 03       # one ad
```

`AD_TOOLS` is a directory containing `node_modules/playwright-core` and an
`ffmpeg` binary. Without it, the script uses a locally installed
`playwright-core` and the `ffmpeg` on `PATH`. `AD_JOBS` sets how many ads
render at once (default 2). Frames are piped straight into ffmpeg and only the
finished MP4 is written here, replacing the previous render.
