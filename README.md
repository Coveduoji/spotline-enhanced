# SpotLine Enhanced

[中文文档](README.zh-CN.md)

A GNOME Shell extension that displays synchronized lyrics with karaoke animation in the top bar.

Fork of [SpotLine](https://github.com/d3osaju/Spotline) by deosaju, with significant enhancements.

> **This fork** ([Coveduoji/spotline-enhanced](https://github.com/Coveduoji/spotline-enhanced)) adds
> GNOME 49–51 support, Musicfox-only binding, album art, and a restyled popup.
> See [Changes in this fork](#changes-in-this-fork).

![Karaoke lyrics in top bar](screenshots/topbar-karaoke.png)

## Features

- **Karaoke sweep effect** - lyrics highlight progressively as the song plays
- **NetEase Cloud Music lyrics** - proxy-friendly lyrics source with broad coverage
- **Lyrics caching** - no redundant API calls for repeated plays
- **Smart timing** - precise lyric sync based on timestamps, not polling
- **Fully customizable** via preferences:
  - Font size
  - Max display width
  - Highlight color (karaoke sweep)
  - Base color (unsung lyrics)
  - Karaoke effect toggle
  - Panel position (left / center / right)
  - Max text length
- **MPRIS support** - works with Spotify, YouTube Music, and browser-based players

## Supported GNOME Versions

45, 46, 47, 48, 49, 50, 51

## Installation

### From GNOME Extensions

Visit [extensions.gnome.org](https://extensions.gnome.org/) and search for "SpotLine Enhanced".

### From Source

```bash
git clone https://github.com/chenlee9876/spotline-enhanced.git
cd spotline-enhanced
./install.sh
```

Then restart GNOME Shell:
- **X11**: `killall -HUP gnome-shell`
- **Wayland**: Log out and log back in

## Configuration

Open the extension preferences via:

```bash
gnome-extensions prefs spotline-enhanced@chenlee9876
```

Or use the GNOME Extensions app / Extension Manager.

![Preferences](screenshots/preferences.png)

## Changes from Original SpotLine

| Feature | SpotLine | SpotLine Enhanced |
|---|---|---|
| Lyrics source | LRCLIB | NetEase Cloud Music |
| HTTP client | Gio.File (no proxy) | Soup.Session (proxy-aware) |
| Animation | Static text | Karaoke sweep effect |
| Caching | None | In-memory lyrics cache |
| Timing | 500ms polling | Smart scheduling per lyric line |
| Customization | Position, text length | + font size, colors, width, karaoke toggle |

## Changes in this fork

### Behavior

- **Musicfox-only binding** — `isSupportedPlayer()` matches the
  `org.mpris.MediaPlayer2.musicfox*` prefix (musicfox's bus name carries a
  `.instance<PID>` suffix), so browsers, Spotify and other MPRIS players
  no longer take over the top-bar lyrics.
- **Hide when idle** — the indicator is hidden entirely instead of showing
  "No music playing".
- **D-Bus player watching fixed** — `Gio.bus_watch_name()` does not accept
  wildcards (`org.mpris.MediaPlayer2.*` failed a `g_dbus_is_name` assertion and
  never fired). Replaced with a `NameOwnerChanged` subscription on the session bus.
- **Removed the hover info icon** from the panel button.

### Popup panel

- **Album art** — 96px rounded cover loaded from `mpris:artUrl` through
  `St.TextureCache.load_uri_async()`, with a CD icon as fallback.
- **Restyled playback controls** — circular buttons with hover/pressed feedback
  (`.spotline-control-button`).
- **Player name** — shows `🎵 Musicfox` when connected to musicfox.

### Compatibility

- `shell-version` extended to `49`, `50`, `51` (verified working on GNOME Shell 50.6,
  Fedora 44).

## License

GPL-3.0 - see [LICENSE](LICENSE)

Based on [SpotLine](https://github.com/d3osaju/Spotline) by deosaju, licensed under GPL-3.0.
