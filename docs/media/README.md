# Product media

`cover.png` is original AI-generated artwork. The other PNGs and GIF show the actual desktop application and its embedded OpenCode view.

The recording uses a deterministic local mock provider and a temporary demo project. OpenCode reads an actual file, but the response is scripted. Keep that disclosure with the demo; it is not proof of live Publik inference.

## Re-record

With dependencies installed and FFmpeg available:

```sh
npm run build
npx tsx scripts/capture-demo.ts
ffmpeg -y -framerate 2 -i artifacts/demo-frames/%04d.png \
  -filter_complex '[0:v]tpad=stop_mode=clone:stop_duration=2,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3' \
  -loop 0 docs/media/demo.gif
```

The recorder isolates its profile and workspace, excludes Publik credentials from the app environment, and removes its temporary project afterward. Frames are saved under ignored `artifacts/demo-frames`. Capture the embedded view directly: Electron's parent-window capture does not include WebContentsView pixels.
