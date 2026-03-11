# Camera View

Side-by-side camera viewer for [go2rtc](https://github.com/AlexxIT/go2rtc) streams with automatic cry detection and audio switching.

## Features

- **Split / Single view** — two streams side by side, or one stream fullscreen
- **Automatic cry detection** — detects elevated sound above a rolling baseline (handles white noise machines), zooms in on the active stream
- **Auto audio switching** — routes audio from whichever stream has sound activity
- **Resilient long-running sessions** — WebRTC connection watchdog, stale frame detection, periodic forced reconnect, page visibility handling
- **iPadOS optimised** — fullscreen support, Add to Home Screen (standalone PWA), safe area handling
- **Configurable** — sensitivity, calm timeout, baseline adaptation time, go2rtc URL

## How Cry Detection Works

The app maintains a rolling baseline of audio RMS (exponential moving average) that adapts to constant background noise like white noise machines. When audio spikes above the baseline by a configurable ratio (default 2.5×) for more than 1.5 seconds, the crying stream expands to fullscreen with the other stream in a small picture-in-picture corner. The view returns to normal after the configured calm timeout (default 30 seconds of quiet).

## Deployment

Built as a Docker image and deployed to Kubernetes via Flux CD. See the [home-ops](https://github.com/adampetrovic/home-ops) repo for the Kubernetes manifests.

```bash
docker build -t camera-view .
docker run -p 8080:8080 camera-view
```

## Configuration

All settings are persisted in localStorage. On first load, the go2rtc WebSocket URL is auto-detected from the current domain (`camera-view.example.com` → `go2rtc.example.com`).
