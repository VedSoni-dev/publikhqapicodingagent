# Product media

Every screenshot, video and GIF here comes from the real Publik Code app. Nothing uses a mock model.

| File | What it shows |
|:---|:---|
| `cover.png` | Listing cover (1200×630 @2x), rendered from `src/cover.html` around a real app screenshot by `scripts/render-cover.ts`. |
| `01-first-run.png` | First launch on a fresh computer: Publik disclosure, consent, own-key option. |
| `02-publik-linking.png` | Publik provisioned on this computer: balance, Publik's cost disclosure, "Link this computer & pick a plan". |
| `05-settings-own-key.png` | Bring-your-own-key settings. |
| `03-agent-editing.png`, `04-diff-approval.png`, `demo.mp4`, `demo.gif` | Live `publik-balanced` task on a small **sample** project (captured with `MEDIA_LIVE=1`). |

## Re-capture

```sh
npm run build
npx tsx scripts/capture-media.ts                 # no model calls
MEDIA_LIVE=1 npx tsx scripts/capture-media.ts    # live Publik call; needs a linked computer with balance
npx tsx scripts/render-cover.ts
# video → mp4 + gif
ffmpeg -y -i artifacts/demo-video/*.webm -vf "fps=30,scale=1280:-2" -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart docs/media/demo.mp4
ffmpeg -y -ss 3 -t 7 -i docs/media/demo.mp4 -vf "fps=12,scale=960:-1" artifacts/gif/%04d.png && gifski -o docs/media/demo.gif --fps 12 artifacts/gif/*.png
```

The capture script isolates its profile and temp project and removes them afterwards.
