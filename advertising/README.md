# Breezer ads

Five 30-second spots, 1920×1080 at 30 fps, with stereo sound. Each one sells a
different part of Breezer: speed, a clean browser, privacy, the product as a
whole, and a cinematic closing piece.

| File | Idea | Closing line |
| --- | --- | --- |
| [breezer-01-blink.mp4](breezer-01-blink.mp4) | A loading spinner gives way to a beat-cut run of instant actions and a browser that fills with tabs and pages on the beat. | The web, at the speed of you. |
| [breezer-02-unclutter.mp4](breezer-02-unclutter.mp4) | A browser buries itself in pop-ups, upsells and sponsored tiles, then a gust blows it all away to reveal Breezer. | Bloat-free, by design. |
| [breezer-03-unwatched.mp4](breezer-03-unwatched.mp4) | A cursor collects a swarm of trackers until a shockwave snaps every string. Later ones bounce off its shield. | Browse unwatched. |
| [breezer-04-less.mp4](breezer-04-less.mp4) | A kinetic-type manifesto ("Less waiting. Less weight. Less watching. More web.") followed by a montage of real Breezer screens. | The web, without the weight. |
| [breezer-05-tailwind.mp4](breezer-05-tailwind.mp4) | A jump to warp speed with websites streaming past, ending as a portal that opens into Breezer. | Catch the breeze. |

All five end on the same card: logo, wordmark, the three pillars (fast,
bloat-free, private) and the download address.

## Music and sound

The music and sound effects are original. `src/soundtrack.py` synthesizes them
from each ad's own timeline, so drums, risers, impacts and whooshes land on
the same frames as the cuts. No third-party audio is used, so there is nothing
to license or credit.

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

Rendering needs Google Chrome, Node 22, Python 3 with NumPy,
[`playwright-core`](https://www.npmjs.com/package/playwright-core) and an
ffmpeg build that includes libx264:

```sh
AD_TOOLS=/path/to/tools node advertising/src/render.mjs          # all five
AD_TOOLS=/path/to/tools node advertising/src/render.mjs 03       # one ad
```

`AD_TOOLS` is a directory containing `node_modules/playwright-core` and an
`ffmpeg` binary. Without it, the script uses a locally installed
`playwright-core` and the `ffmpeg` on `PATH`. `AD_JOBS` sets how many ads
render at once (default 2). Frames are piped straight into ffmpeg and only the
finished MP4 is written here, replacing the previous render.
