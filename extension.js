import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_PLAYER_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

// Lyrics API configuration - NetEase Cloud Music (accessible through corporate proxy)
const NETEASE_SEARCH_URL = 'https://music.163.com/api/search/get';
const NETEASE_LYRIC_URL = 'https://music.163.com/api/song/lyric';

const LYRICS_CACHE_MAX = 50;

// 只绑定 musicfox 播放器（bus 名带 .instance<PID> 后缀）
function isSupportedPlayer(busName) {
    return busName.startsWith('org.mpris.MediaPlayer2.musicfox');
}

const MusicLyricsIndicator = GObject.registerClass(
    class MusicLyricsIndicator extends PanelMenu.Button {
        _init(settings, extensionPath, extensionUuid) {
            super._init(0.5, 'Music Lyrics Indicator');

            this._settings = settings;
            this._extensionPath = extensionPath;
            this._extensionUuid = extensionUuid;

            // Create a box to hold lyrics container and info icon
            const box = new St.BoxLayout({
                style_class: 'panel-status-menu-box'
            });

            // Karaoke container: two overlapping labels
            this._lyricsContainer = new Clutter.Actor({
                layout_manager: new Clutter.BinLayout(),
                y_align: Clutter.ActorAlign.CENTER
            });

            // Base label (dim, shows full line)
            this._baseLabel = new St.Label({
                text: 'No music playing',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-lyrics-label spotify-lyrics-base'
            });
            this._baseLabel.clutter_text.ellipsize = 3;

            // Highlight label (bright, clipped for karaoke sweep)
            this._highlightLabel = new St.Label({
                text: 'No music playing',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-lyrics-label spotify-lyrics-highlight'
            });
            this._highlightLabel.clutter_text.ellipsize = 3;
            this._highlightLabel.set_clip(0, 0, 0, 0);

            this._lyricsContainer.add_child(this._baseLabel);
            this._lyricsContainer.add_child(this._highlightLabel);

            // Keep a reference for non-karaoke mode
            this._label = this._baseLabel;

            box.add_child(this._lyricsContainer);
            this.add_child(box);

            this._currentTrack = null;
            this._trackArtUrl = null;      // 当前曲目的封面地址
            this._loadedArtUrl = null;     // 已渲染到面板的封面地址
            this._currentLyrics = null;
            this._currentLine = '';
            this._currentLyricIndex = -1;
            this._proxy = null;
            this._propertiesChangedId = null;
            this._lyricsTimeoutId = null;
            this._karaokeTimeoutId = null;
            this._karaokeLineStart = 0;
            this._karaokeLineEnd = 0;
            this._currentBusName = null;
            this._nameOwnerSubId = null;
            this._dbusConn = null;
            this._lyricsCache = new Map();
            this._soupSession = new Soup.Session();
            // 歌词与封面都来自国内（163.com / 126.net），直连即可。
            // 不显式清空的话 Soup 会走 GNOME 系统代理（Clash），
            // 代理一关封面和歌词就全挂了。
            try {
                this._soupSession.set_proxy_resolver(
                    Gio.SimpleProxyResolver.new(null, ['localhost', '127.0.0.1'])
                );
            } catch (e) {
                logError(e, 'Failed to disable proxy for media requests');
            }
            this._isPlaying = false;
            this._debounceTimeoutId = null;
            this._retryTimeoutId = null;

            // 是否显示歌词（由首选项控制）
            this._showLyrics = this._settings.get_boolean('show-lyrics');

            // Apply initial style from settings
            this._applyStyle();

            // Connect setting signals for live updates
            this._settingsSignals = [];
            const styleKeys = ['font-size', 'max-width', 'highlight-color', 'base-color'];
            for (const key of styleKeys) {
                this._settingsSignals.push(
                    this._settings.connect(`changed::${key}`, () => this._applyStyle())
                );
            }
            this._settingsSignals.push(
                this._settings.connect('changed::max-text-length', () => this._updateLabelText())
            );
            this._settingsSignals.push(
                this._settings.connect('changed::karaoke-enabled', () => this._onKaraokeToggled())
            );
            this._settingsSignals.push(
                this._settings.connect('changed::show-lyrics', () => this._onShowLyricsChanged())
            );

            this._buildMenu();

            // 面板打开时才去取封面
            this.menu.connect('open-state-changed', (menu, isOpen) => {
                if (isOpen) {
                    this._maybeLoadCover();
                }
            });

            this._setupDBusMonitoring();
        }

        _buildMenu() {
            // 设置入口：点击齿轮直接打开扩展首选项。
            // 左下角齿轮 + 右下角弧线做视觉平衡，两者半透明，
            // 悬停一起淡入、移开一起淡出
            this._gearMenu = new PopupMenu.PopupBaseMenuItem({ reactive: true });
            this._gearMenu.add_style_class_name('spotline-footer-item');
            this._gearMenu.connect('activate', () => this._openPreferences());
            // 内联样式优先于主题样式表，确保 hover/按下/open 都没有底色遮罩，
            // 同时把上边距压到最小
            this._gearMenu.set_style(
                'background-color: transparent;' +
                'background-image: none;' +
                'box-shadow: none;' +
                'border: none;' +
                'padding-top: 0;' +
                'padding-bottom: 0;' +
                'padding-left: 3px;' +
                'padding-right: 3px;' +
                'margin-top: 0;' +
                'min-height: 18px;'
            );
            // 两个图标都靠向行的下边缘，贴近面板左下/右下的圆角
            this._gearIcon = new St.Icon({
                icon_name: 'emblem-system-symbolic',
                icon_size: 12,
                opacity: 140,
                y_align: Clutter.ActorAlign.END
            });
            this._balanceArc = new St.Icon({
                gicon: this._iconFor('arc'),
                icon_size: 14,
                opacity: 140,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END
            });

            this._gearMenu.add_child(this._gearIcon);
            this._gearMenu.add_child(new St.Bin({ x_expand: true }));
            this._gearMenu.add_child(this._balanceArc);

            const fadeTo = (opacity) => {
                for (const icon of [this._gearIcon, this._balanceArc]) {
                    icon.ease({
                        opacity, duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD
                    });
                }
            };
            this._gearMenu.connect('enter-event', () => fadeTo(255));
            this._gearMenu.connect('leave-event', () => fadeTo(140));

            // 封面图
            this._coverIcon = new St.Icon({
                icon_name: 'media-optical-cd-audio-symbolic',
                icon_size: 128,
                style_class: 'spotline-cover'
            });
            const coverBox = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER
            });
            coverBox.add_child(this._coverIcon);
            const coverItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            coverItem.add_child(coverBox);
            this.menu.addMenuItem(coverItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // 曲名（加粗）/ 歌手（次级）
            this._titleItem = new PopupMenu.PopupMenuItem('No track playing', {
                reactive: false
            });
            this._titleItem.label.add_style_class_name('spotline-title');
            this._titleItem.label.clutter_text.ellipsize = 3;
            this._titleItem.label.style = 'max-width: 300px;';
            this.menu.addMenuItem(this._titleItem);

            this._artistItem = new PopupMenu.PopupMenuItem('', {
                reactive: false
            });
            this._artistItem.label.add_style_class_name('spotline-artist');
            this._artistItem.label.clutter_text.ellipsize = 3;
            this._artistItem.label.style = 'max-width: 300px;';
            this.menu.addMenuItem(this._artistItem);

            // Player info section
            this._playerInfoItem = new PopupMenu.PopupMenuItem('No player connected', {
                reactive: false
            });
            this._playerInfoItem.label.add_style_class_name('spotline-player');
            this.menu.addMenuItem(this._playerInfoItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Playback controls：主操作（播放/暂停）用强调色实心大圆，
            // 前后切歌为无底色的次级小按钮
            const controlsBox = new St.BoxLayout({
                style_class: 'popup-menu-item',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 12px;'
            });

            const makeControl = (iconName, onClick) => {
                const btn = new St.Button({
                    style_class: 'spotline-control-button',
                    child: new St.Icon({
                        gicon: this._iconFor(iconName),
                        icon_size: 16
                    }),
                    y_align: Clutter.ActorAlign.CENTER
                });
                btn.connect('clicked', onClick);
                return btn;
            };

            const prevButton = makeControl('skip-backward', () => this._controlPlayback('Previous'));
            this._prevButton = prevButton;

            const playPauseButton = makeControl('play', () => this._controlPlayback('PlayPause'));
            this._playPauseButton = playPauseButton;

            const nextButton = makeControl('skip-forward', () => this._controlPlayback('Next'));
            this._nextButton = nextButton;

            controlsBox.add_child(prevButton);
            controlsBox.add_child(playPauseButton);
            controlsBox.add_child(nextButton);

            const controlsItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            controlsItem.add_child(controlsBox);
            this.menu.addMenuItem(controlsItem);

            // 设置入口置于最底部（不加上方分隔线）
            this.menu.addMenuItem(this._gearMenu);

        }

        // 齿轮点击：打开扩展首选项
        _openPreferences() {
            try {
                const extension = Main.extensionManager.lookup(this._extensionUuid);
                if (extension) {
                    extension.openPreferences();
                    this.menu.close();
                    return;
                }
            } catch (e) {
                logError(e, 'Failed to open preferences via extensionManager');
            }

            try {
                Util.spawn(['gnome-extensions', 'prefs', this._extensionUuid]);
                this.menu.close();
            } catch (e) {
                logError(e, 'Failed to spawn gnome-extensions prefs');
            }
        }

        _applyStyle() {
            const fontSize = this._settings.get_int('font-size');
            const maxWidth = this._settings.get_int('max-width');
            const baseColor = this._settings.get_string('base-color');
            const highlightColor = this._settings.get_string('highlight-color');

            const baseStyle = `font-size: ${fontSize}px; max-width: ${maxWidth}px; color: ${baseColor};`;
            const hlStyle = `font-size: ${fontSize}px; max-width: ${maxWidth}px; color: ${highlightColor};`;

            this._baseLabel.set_style(baseStyle);
            this._highlightLabel.set_style(hlStyle);
        }

        // 首选项里切换「显示歌词」时即时生效
        _onShowLyricsChanged() {
            this._showLyrics = this._settings.get_boolean('show-lyrics');

            if (!this._showLyrics) {
                if (this._lyricsTimeoutId) {
                    GLib.source_remove(this._lyricsTimeoutId);
                    this._lyricsTimeoutId = null;
                }
                this._stopKaraokeAnimation();
            }
            this._updateTrackInfo();
        }

        _onKaraokeToggled() {
            const enabled = this._settings.get_boolean('karaoke-enabled');
            if (!enabled) {
                this._stopKaraokeAnimation();
                this._highlightLabel.set_clip(0, 0, 0, 0);
            } else if (this._currentLyrics && this._currentLyrics.length > 0) {
                this._scheduleNextLyricUpdate();
            }
        }

        // ---- 圆角图标：运行时按主题前景色生成 SVG，深浅主题都能看清 ----
        // （不用 -symbolic 名称：FileIcon 走 pixbuf 渲染，不会做符号化重着色）
        _themIconColor() {
            try {
                const node = this.menu.actor.get_theme_node();
                if (node) {
                    const c = node.get_foreground_color();
                    const hex = (v) => v.toString(16).padStart(2, '0');
                    return `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`;
                }
            } catch (e) {
                // 落到默认值
            }
            return '#808080';
        }

        _iconSvg(name, color) {
            const shapes = {
                'play':
                    '<path d="M5.2 3.4 L12 8 L5.2 12.6 Z" fill="COLOR" stroke="COLOR" ' +
                    'stroke-width="2.2" stroke-linejoin="round"/>',
                'pause':
                    '<rect x="4" y="2.8" width="3.2" height="10.4" rx="1.6" fill="COLOR"/>' +
                    '<rect x="8.8" y="2.8" width="3.2" height="10.4" rx="1.6" fill="COLOR"/>',
                'skip-backward':
                    '<rect x="3" y="2.8" width="2.6" height="10.4" rx="1.3" fill="COLOR"/>' +
                    '<path d="M13 3.6 L6.8 8 L13 12.4 Z" fill="COLOR" stroke="COLOR" ' +
                    'stroke-width="2" stroke-linejoin="round"/>',
                'skip-forward':
                    '<rect x="10.4" y="2.8" width="2.6" height="10.4" rx="1.3" fill="COLOR"/>' +
                    '<path d="M3 3.6 L9.2 8 L3 12.4 Z" fill="COLOR" stroke="COLOR" ' +
                    'stroke-width="2" stroke-linejoin="round"/>',
                // 右下角装饰：单条圆弧，呼应面板圆角（约 120°）
                'arc':
                    '<path d="M15 9 A6 6 0 0 1 6 14.2" fill="none" stroke="COLOR" ' +
                    'stroke-width="2" stroke-linecap="round"/>',
            };
            const body = (shapes[name] || '').split('COLOR').join(color);
            return '<?xml version="1.0" encoding="UTF-8"?>' +
                '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
                body + '</svg>';
        }

        _iconFor(name) {
            const color = this._themIconColor();
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'spotline-enhanced', 'icons']);
            GLib.mkdir_with_parents(dir, 0o755);

            const path = GLib.build_filenamev([dir, `${name}-${color.slice(1)}.svg`]);
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
                GLib.file_set_contents(path, this._iconSvg(name, color));
            }
            return new Gio.FileIcon({ file: Gio.File.new_for_path(path) });
        }

        // 挂到 panel 之后再刷新一次：_buildMenu() 时控件还没主题节点，
        // 只能拿到兜底色
        refreshControlIcons() {
            try {
                if (this._prevButton) {
                    this._prevButton.child.set_gicon(this._iconFor('skip-backward'));
                }
                if (this._nextButton) {
                    this._nextButton.child.set_gicon(this._iconFor('skip-forward'));
                }
                if (this._balanceArc) {
                    this._balanceArc.set_gicon(this._iconFor('arc'));
                }
                if (this._playPauseButton) {
                    let playing = false;
                    try {
                        const status = this._playerProxy?.get_cached_property('PlaybackStatus');
                        playing = !!status && status.unpack() === 'Playing';
                    } catch (e) {
                        playing = false;
                    }
                    this._playPauseButton.child.set_gicon(this._iconFor(playing ? 'pause' : 'play'));
                }
            } catch (e) {
                logError(e, 'Failed to refresh control icons');
            }
        }

        _controlPlayback(action) {
            if (!this._playerProxy) {
                return;
            }

            try {
                this._playerProxy.call(
                    action,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    null
                );
            } catch (e) {
                logError(e, `Failed to ${action}`);
            }
        }

        _updatePlayPauseButton() {
            if (!this._playerProxy || !this._playPauseButton) {
                return;
            }

            try {
                const playbackStatus = this._playerProxy.get_cached_property('PlaybackStatus');
                if (playbackStatus) {
                    const status = playbackStatus.unpack();
                    this._playPauseButton.child.set_gicon(
                        this._iconFor(status === 'Playing' ? 'pause' : 'play')
                    );
                }
            } catch (e) {
                logError(e, 'Failed to update play/pause button');
            }
        }

        _setupDBusMonitoring() {
            // Watch for MPRIS players appearing/disappearing.
            // NOTE: Gio.bus_watch_name() does NOT support wildcards, so the old
            // "org.mpris.MediaPlayer2.*" watch failed with a g_dbus_is_name
            // assertion and never fired. Subscribe to the D-Bus daemon's
            // NameOwnerChanged signal instead, filtering on the MPRIS prefix.
            try {
                this._dbusConn = Gio.bus_get_sync(Gio.BusType.SESSION, null);
                this._nameOwnerSubId = this._dbusConn.signal_subscribe(
                    'org.freedesktop.DBus',
                    'org.freedesktop.DBus',
                    'NameOwnerChanged',
                    '/org/freedesktop/DBus',
                    null,
                    Gio.DBusSignalFlags.NONE,
                    (conn, sender, path, iface, signal, params) => {
                        const name = params.deep_unpack()[0];
                        if (name && name.startsWith('org.mpris.MediaPlayer2.')) {
                            this._findActivePlayer();
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to watch for MPRIS players');
            }

            this._findActivePlayer();
        }

        _findActivePlayer() {
            try {
                const dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    null
                );

                dbusProxy.call(
                    'ListNames',
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        try {
                            const reply = proxy.call_finish(result);
                            const names = reply.get_child_value(0).deep_unpack();

                            // First try to find a playing supported player
                            let foundPlayer = null;

                            for (const name of names) {
                                if (isSupportedPlayer(name)) {
                                    if (this._isPlayerPlaying(name)) {
                                        foundPlayer = name;
                                        break;
                                    }
                                }
                            }

                            // If no playing player, connect to any supported player
                            if (!foundPlayer) {
                                for (const name of names) {
                                    if (isSupportedPlayer(name)) {
                                        foundPlayer = name;
                                        break;
                                    }
                                }
                            }

                            if (foundPlayer) {
                                this._tryConnectToPlayer(foundPlayer);
                            } else {
                                this._updateLabelText('No music playing');
                            }
                        } catch (e) {
                            logError(e, 'Failed to list DBus names');
                            this._updateLabelText('No music playing');
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to query DBus');
                this._updateLabelText('No music playing');
            }
        }

        _isPlayerPlaying(busName) {
            try {
                const playerProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    MPRIS_PLAYER_INTERFACE,
                    null
                );

                const playbackStatus = playerProxy.get_cached_property('PlaybackStatus');
                if (playbackStatus) {
                    const status = playbackStatus.unpack();
                    return status === 'Playing';
                }
            } catch (e) {
                // Ignore errors, player might not be available
            }
            return false;
        }

        _tryConnectToPlayer(busName) {
            try {
                // Create proxy for properties interface
                const proxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    'org.freedesktop.DBus.Properties',
                    null
                );

                // Create proxy for player interface to monitor changes
                const playerProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    MPRIS_PLAYER_INTERFACE,
                    null
                );

                // Disconnect previous player if any
                if (this._propertiesChangedId && this._playerProxy) {
                    this._playerProxy.disconnect(this._propertiesChangedId);
                }

                this._proxy = proxy;
                this._playerProxy = playerProxy;
                this._currentBusName = busName;

                this._propertiesChangedId = this._playerProxy.connect(
                    'g-properties-changed',
                    this._onPropertiesChanged.bind(this)
                );

                this._updatePlayerInfo();
                this._updateTrackInfo();
                return true;
            } catch (e) {
                return false;
            }
        }

        _updatePlayerInfo() {
            if (!this._currentBusName) {
                this._playerInfoItem.label.text = 'No player connected';
                return;
            }

            let playerName = 'Unknown Player';
            let playerIcon = '♪';

            if (this._currentBusName.includes('musicfox')) {
                playerName = 'Musicfox';
                playerIcon = '🎵';
            } else if (this._currentBusName.includes('spotify')) {
                playerName = 'Spotify';
                playerIcon = '🎵';
            } else if (this._currentBusName.includes('youtube-music')) {
                playerName = 'YouTube Music';
                playerIcon = '🎵';
            } else if (this._currentBusName.includes('chromium')) {
                playerName = 'Chromium';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('chrome')) {
                playerName = 'Chrome';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('firefox')) {
                playerName = 'Firefox';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('brave')) {
                playerName = 'Brave';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('edge')) {
                playerName = 'Edge';
                playerIcon = '🌐';
            }

            this._playerInfoItem.label.text = `${playerIcon} Playing from ${playerName}`;
        }

        _coverCacheDir() {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'spotline-enhanced']);
            GLib.mkdir_with_parents(dir, 0o755);
            return dir;
        }

        // 面板关闭时不下载封面，避免为每首歌都发一次请求
        _maybeLoadCover() {
            const artUrl = this._trackArtUrl;
            if (!artUrl || artUrl === this._loadedArtUrl || !this.menu.isOpen) {
                return;
            }
            this._loadCover(artUrl);
        }

        _applyCover(path, artUrl) {
            if (artUrl !== this._trackArtUrl) {
                return;   // 期间已切歌，丢弃
            }
            this._loadedArtUrl = artUrl;
            this._coverIcon.set_gicon(new Gio.FileIcon({ file: Gio.File.new_for_path(path) }));
        }

        // 缓存只保留最近 N 张，防止无限增长
        _pruneCoverCache(dir, keep = 60) {
            try {
                const enumR = Gio.File.new_for_path(dir).enumerate_children(
                    'standard::name,time::modified',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );

                const entries = [];
                let info;
                while ((info = enumR.next_file(null)) !== null) {
                    entries.push({
                        name: info.get_name(),
                        mtime: info.get_attribute_uint64('time::modified')
                    });
                }
                enumR.close(null);

                if (entries.length <= keep) {
                    return;
                }

                entries.sort((a, b) => b.mtime - a.mtime);
                for (const entry of entries.slice(keep)) {
                    Gio.File.new_for_path(GLib.build_filenamev([dir, entry.name])).delete(null);
                }
            } catch (e) {
                // 清理失败不影响使用
            }
        }

        _loadCover(artUrl) {
            // 以 URL 哈希做键：命中缓存就不发请求
            const cacheDir = this._coverCacheDir();
            const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, artUrl, -1).slice(0, 16);
            const path = GLib.build_filenamev([cacheDir, `${key}.img`]);

            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                this._applyCover(path, artUrl);
                return;
            }

            try {
                const msg = Soup.Message.new('GET', artUrl);
                msg.get_request_headers().append('User-Agent', 'Mozilla/5.0');

                this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                    try {
                        const bytes = sess.send_and_read_finish(result);
                        if (msg.get_status() !== Soup.Status.OK) {
                            logError(new Error(`HTTP ${msg.get_status()}`), 'Album art request failed');
                            return;
                        }

                        GLib.file_set_contents(path, bytes.get_data());
                        this._applyCover(path, artUrl);
                        this._pruneCoverCache(cacheDir);
                    } catch (e) {
                        logError(e, 'Failed to download album art');
                    }
                });
            } catch (e) {
                logError(e, 'Failed to request album art');
            }
        }

        _onPropertiesChanged() {
            // Handle playback status changes immediately (pause/resume)
            const wasPlaying = this._isPlaying;
            try {
                const status = this._playerProxy.get_cached_property('PlaybackStatus');
                this._isPlaying = status ? status.unpack() === 'Playing' : false;
            } catch (e) {
                this._isPlaying = false;
            }

            if (wasPlaying && !this._isPlaying) {
                this._stopKaraokeAnimation();
                if (this._lyricsTimeoutId) {
                    GLib.source_remove(this._lyricsTimeoutId);
                    this._lyricsTimeoutId = null;
                }
            } else if (!wasPlaying && this._isPlaying) {
                if (this._currentLyrics && this._currentLyrics.length > 0) {
                    this._currentLyricIndex = -1;
                    this._scheduleNextLyricUpdate();
                }
            }

            this._updatePlayPauseButton();

            // Debounce track info updates — Spotify fires multiple rapid changes on track switch
            if (this._debounceTimeoutId) {
                GLib.source_remove(this._debounceTimeoutId);
            }
            this._debounceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._debounceTimeoutId = null;
                this._updateTrackInfo();
                return GLib.SOURCE_REMOVE;
            });
        }

        _updateTrackInfo() {
            if (!this._playerProxy) {
                return;
            }

            try {
                const metadata = this._playerProxy.get_cached_property('Metadata');
                if (!metadata) {
                    this._updateLabelText('No music playing');
                    this._titleItem.label.text = 'No track playing';
                    this._artistItem.label.text = '';
                    return;
                }

                const metadataDict = metadata.deep_unpack();
                const title = metadataDict['xesam:title']?.unpack() || null;
                const artist = metadataDict['xesam:artist']?.deep_unpack()[0] || null;
                const album = metadataDict['xesam:album']?.unpack() || null;
                const artUrl = metadataDict['mpris:artUrl']?.unpack() || null;

                // If both title and artist are missing, show icon or nothing
                if (!title && !artist) {
                    this._updateLabelText('♪');
                    this._titleItem.label.text = '♪';
                    this._artistItem.label.text = 'Unknown track';
                    return;
                }

                this._currentTrack = {
                    title: title || 'Unknown Track',
                    artist: artist || 'Unknown Artist',
                    album: album || 'Unknown Album'
                };

                // Update menu with track info
                this._titleItem.label.text = this._currentTrack.title;
                this._artistItem.label.text = this._currentTrack.artist;

                // 封面：记录当前曲目的封面地址，仅在面板打开时加载
                this._trackArtUrl = artUrl;
                this._maybeLoadCover();

                // Try to fetch lyrics if enabled
                if (this._showLyrics) {
                    this._fetchLyrics(this._currentTrack.title, this._currentTrack.artist);
                } else {
                    this._updateLabelText(`${this._currentTrack.artist} - ${this._currentTrack.title}`);
                }
            } catch (e) {
                logError(e, 'Failed to get track info');
            }
        }

        _fetchLyrics(title, artist, isRetry = false) {
            // Clear any existing lyrics timeout
            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            // Clear pending retry
            if (this._retryTimeoutId) {
                GLib.source_remove(this._retryTimeoutId);
                this._retryTimeoutId = null;
            }

            // Check cache first
            const cacheKey = `${artist}::${title}`;
            if (this._lyricsCache.has(cacheKey)) {
                const cached = this._lyricsCache.get(cacheKey);
                if (cached.length > 0) {
                    this._currentLyrics = cached;
                    this._currentLyricIndex = -1;
                    this._startLyricsDisplay();
                } else {
                    this._updateLabelText(`${artist} - ${title}`);
                }
                return;
            }

            // Show loading state
            this._updateLabelText('Loading...');

            // Step 1: Search song on NetEase to get song ID
            const searchUrl = `${NETEASE_SEARCH_URL}?s=${encodeURIComponent(title + ' ' + artist)}&type=1&limit=1`;
            const searchMsg = Soup.Message.new('GET', searchUrl);
            searchMsg.get_request_headers().append('User-Agent', 'Mozilla/5.0');

            this._soupSession.send_and_read_async(searchMsg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    if (searchMsg.get_status() !== Soup.Status.OK) {
                        this._onFetchFailed(title, artist, isRetry);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const songs = data?.result?.songs;

                    if (!songs || songs.length === 0) {
                        this._updateLabelText(`${artist} - ${title}`);
                        return;
                    }

                    const songId = songs[0].id;
                    this._fetchNeteaseLyric(songId, title, artist, isRetry);
                } catch (e) {
                    logError(e, 'Failed to search lyrics');
                    this._onFetchFailed(title, artist, isRetry);
                }
            });
        }

        _onFetchFailed(title, artist, isRetry) {
            if (!isRetry) {
                // Retry once after 2 seconds
                this._retryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                    this._retryTimeoutId = null;
                    this._fetchLyrics(title, artist, true);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._updateLabelText(`${artist} - ${title}`);
            }
        }

        _fetchNeteaseLyric(songId, title, artist, isRetry = false) {
            // Step 2: Fetch lyrics by song ID
            const lyricUrl = `${NETEASE_LYRIC_URL}?id=${songId}&lv=1`;
            const lyricMsg = Soup.Message.new('GET', lyricUrl);
            lyricMsg.get_request_headers().append('User-Agent', 'Mozilla/5.0');

            this._soupSession.send_and_read_async(lyricMsg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    if (lyricMsg.get_status() !== Soup.Status.OK) {
                        this._onFetchFailed(title, artist, isRetry);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const lrcText = data?.lrc?.lyric;

                    const cacheKey = `${artist}::${title}`;
                    if (lrcText) {
                        this._currentLyrics = this._parseLRC(lrcText);
                        this._setCacheEntry(cacheKey, this._currentLyrics);
                        this._currentLyricIndex = -1;
                        if (this._currentLyrics.length > 0) {
                            this._startLyricsDisplay();
                        } else {
                            this._updateLabelText(`${artist} - ${title}`);
                        }
                    } else {
                        this._setCacheEntry(cacheKey, []);
                        this._updateLabelText(`${artist} - ${title}`);
                    }
                } catch (e) {
                    logError(e, 'Failed to fetch lyrics');
                    this._onFetchFailed(title, artist, isRetry);
                }
            });
        }

        _parseLRC(lrcText) {
            // Parse LRC format: [mm:ss.xx]lyrics or [mm:ss.xxx]lyrics
            const lines = [];
            const lrcLines = lrcText.split('\n');
            // Skip NetEase metadata lines (作词, 作曲, 编曲, etc.)
            const metadataPattern = /^(作词|作曲|编曲|制作|混音|母带|录音|吉他|贝斯|鼓|钢琴|和声|Lyricist|Composer|Arranger|Producer)/;

            for (const line of lrcLines) {
                const match = line.match(/\[(\d+):(\d+)\.(\d+)\](.*)/);
                if (match) {
                    const minutes = parseInt(match[1]);
                    const seconds = parseInt(match[2]);
                    const fraction = match[3];
                    const text = match[4].trim();

                    // Convert fraction to milliseconds (handle both .xx and .xxx)
                    let ms = parseInt(fraction);
                    if (fraction.length === 2) ms *= 10;
                    else if (fraction.length === 1) ms *= 100;

                    const timeMs = (minutes * 60 + seconds) * 1000 + ms;

                    if (text && !metadataPattern.test(text)) {
                        lines.push({ time: timeMs, text: text });
                    }
                }
            }

            return lines.sort((a, b) => a.time - b.time);
        }

        _startLyricsDisplay() {
            if (!this._currentLyrics || this._currentLyrics.length === 0) {
                return;
            }

            this._scheduleNextLyricUpdate();
        }

        _stopKaraokeAnimation() {
            if (this._karaokeTimeoutId) {
                GLib.source_remove(this._karaokeTimeoutId);
                this._karaokeTimeoutId = null;
            }
        }

        _scheduleNextLyricUpdate() {
            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            if (!this._proxy || !this._currentLyrics || this._currentLyrics.length === 0) {
                return;
            }

            try {
                this._proxy.call(
                    'Get',
                    new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'Position']),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        try {
                            const reply = proxy.call_finish(result);
                            const positionUs = reply.get_child_value(0).get_variant().get_int64();
                            const positionMs = positionUs / 1000;

                            // Find current lyric index
                            let currentIndex = -1;
                            for (let i = this._currentLyrics.length - 1; i >= 0; i--) {
                                if (this._currentLyrics[i].time <= positionMs) {
                                    currentIndex = i;
                                    break;
                                }
                            }

                            // New line: update text and start karaoke sweep
                            if (currentIndex !== this._currentLyricIndex) {
                                this._currentLyricIndex = currentIndex;
                                this._stopKaraokeAnimation();

                                if (currentIndex >= 0) {
                                    const lineText = this._currentLyrics[currentIndex].text;
                                    this._currentLine = lineText;
                                    const karaokeOn = this._settings.get_boolean('karaoke-enabled');

                                    // Fade in on line change
                                    this._baseLabel.opacity = 0;
                                    this._highlightLabel.opacity = 0;
                                    this._updateLabelText(lineText, karaokeOn);
                                    this._baseLabel.ease({
                                        opacity: 255, duration: 120,
                                        mode: Clutter.AnimationMode.EASE_IN_QUAD
                                    });
                                    this._highlightLabel.ease({
                                        opacity: 255, duration: 120,
                                        mode: Clutter.AnimationMode.EASE_IN_QUAD
                                    });

                                    if (karaokeOn) {
                                        // Karaoke timing: current line start → next line start
                                        this._karaokeLineStart = this._currentLyrics[currentIndex].time;
                                        const nextIdx = currentIndex + 1;
                                        this._karaokeLineEnd = nextIdx < this._currentLyrics.length
                                            ? this._currentLyrics[nextIdx].time
                                            : this._karaokeLineStart + 5000;

                                        this._highlightLabel.set_clip(0, 0, 0, 0);
                                        this._startKaraokeAnimation();
                                    }
                                }
                            }

                            // Schedule check for next line change
                            const nextIndex = currentIndex + 1;
                            let delay;
                            if (nextIndex < this._currentLyrics.length) {
                                delay = Math.max(50, this._currentLyrics[nextIndex].time - positionMs);
                            } else {
                                delay = 1000;
                            }

                            this._lyricsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                                this._lyricsTimeoutId = null;
                                this._scheduleNextLyricUpdate();
                                return GLib.SOURCE_REMOVE;
                            });
                        } catch (e) {
                            if (this._lyricsTimeoutId) {
                                GLib.source_remove(this._lyricsTimeoutId);
                            }
                            this._lyricsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                                this._lyricsTimeoutId = null;
                                this._scheduleNextLyricUpdate();
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to update lyric line');
            }
        }

        _startKaraokeAnimation() {
            // Record the wall-clock time and player position at animation start
            // to interpolate locally without DBus calls every frame
            this._karaokeWallStart = GLib.get_monotonic_time() / 1000; // ms
            this._karaokePositionAtStart = this._karaokeLineStart;

            // Sync once from DBus to get accurate starting position
            try {
                this._proxy.call(
                    'Get',
                    new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'Position']),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        try {
                            const reply = proxy.call_finish(result);
                            const positionMs = reply.get_child_value(0).get_variant().get_int64() / 1000;
                            this._karaokeWallStart = GLib.get_monotonic_time() / 1000;
                            this._karaokePositionAtStart = positionMs;
                        } catch (e) {
                            // use defaults set above
                        }
                    }
                );
            } catch (e) {
                // use defaults
            }

            this._karaokeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
                const duration = this._karaokeLineEnd - this._karaokeLineStart;
                if (duration <= 0) {
                    this._karaokeTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }

                // Interpolate position from wall clock
                const wallNow = GLib.get_monotonic_time() / 1000;
                const estimatedPosition = this._karaokePositionAtStart + (wallNow - this._karaokeWallStart);
                const elapsed = estimatedPosition - this._karaokeLineStart;
                const progress = Math.min(1.0, Math.max(0.0, elapsed / duration));

                const totalWidth = this._highlightLabel.get_width();
                const totalHeight = this._highlightLabel.get_height();
                this._highlightLabel.set_clip(0, 0, totalWidth * progress, totalHeight);

                if (progress >= 1.0) {
                    this._karaokeTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });
        }

        _updateLabelText(text = null, isLyric = false) {
            if (text !== null) {
                this._currentText = text;
            }

            const display = this._currentText || 'No music playing';

            // 无音乐播放时隐藏整个指示器，而不是在顶栏显示 "No music playing"
            if (display === 'No music playing') {
                this.hide();
                return;
            }
            this.show();

            const maxLength = this._settings.get_int('max-text-length');
            const truncated = this._truncateText(display, maxLength);
            this._baseLabel.set_text(truncated);
            this._highlightLabel.set_text(truncated);

            if (!isLyric) {
                // Non-lyric text: show highlight fully, base dim
                this._highlightLabel.remove_clip();
            }
        }

        _setCacheEntry(key, value) {
            if (this._lyricsCache.size >= LYRICS_CACHE_MAX) {
                // Remove oldest entry (first key in Map iteration order)
                const oldest = this._lyricsCache.keys().next().value;
                this._lyricsCache.delete(oldest);
            }
            this._lyricsCache.set(key, value);
        }

        _truncateText(text, maxLength) {
            if (text.length <= maxLength) {
                return text;
            }
            return text.substring(0, maxLength - 3) + '...';
        }

        destroy() {
            if (this._settingsSignals) {
                for (const id of this._settingsSignals) {
                    this._settings.disconnect(id);
                }
                this._settingsSignals = null;
            }

            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            this._stopKaraokeAnimation();

            if (this._debounceTimeoutId) {
                GLib.source_remove(this._debounceTimeoutId);
                this._debounceTimeoutId = null;
            }

            if (this._retryTimeoutId) {
                GLib.source_remove(this._retryTimeoutId);
                this._retryTimeoutId = null;
            }

            if (this._propertiesChangedId && this._playerProxy) {
                this._playerProxy.disconnect(this._propertiesChangedId);
                this._propertiesChangedId = null;
            }

            if (this._nameOwnerSubId) {
                if (this._dbusConn) {
                    this._dbusConn.signal_unsubscribe(this._nameOwnerSubId);
                    this._dbusConn = null;
                }
                this._nameOwnerSubId = null;
            }

            this._proxy = null;
            this._playerProxy = null;
            if (this._soupSession) {
                this._soupSession.abort();
                this._soupSession = null;
            }
            this._lyricsCache.clear();
            super.destroy();
        }
    });

export default class MusicLyricsExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._settings = null;
    }

    enable() {
        this._settings = this.getSettings();
        this._indicator = new MusicLyricsIndicator(this._settings, this.path, this.uuid);

        // 本扩展用 add_child() 手动挂到 panel 的 box 上，绕过了
        // Main.panel.addToStatusArea() → Panel._onMenuSet() 这一步，
        // 菜单因此没有注册到 panel 的 menuManager，也就没有模态抓取，
        // 表现为「点面板外面关不掉」。这里补上注册。
        try {
            Main.panel.menuManager.addMenu(this._indicator.menu);
        } catch (e) {
            logError(e, 'Failed to register lyrics menu with the panel menu manager');
        }

        this._updatePosition();

        this._settingsSignalId = this._settings.connect('changed::position-in-panel', () => {
            this._updatePosition();
        });
    }

    disable() {
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    _updatePosition() {
        if (!this._indicator) return;

        // Remove from current parent if applied
        if (this._indicator.get_parent()) {
            this._indicator.get_parent().remove_child(this._indicator);
        }

        const position = this._settings.get_string('position-in-panel');

        if (position === 'left') {
            Main.panel._leftBox.add_child(this._indicator);
            // 锚定指示器左边缘：歌词长度变化时菜单不会左右跳动
            this._setMenuAlignment(0.0);
        } else if (position === 'center') {
            Main.panel._centerBox.add_child(this._indicator);
            this._setMenuAlignment(0.5);
        } else {
            // Default to right (status area)
            // We use addToStatusArea but need to handle re-adding carefully
            // addToStatusArea destroys existing indicator with same role, but we handle that

            // Since we manually removed it, we can just add it back using the panel method
            // or just use addToStatusArea again (which is safer for right side)
            Main.panel.addToStatusArea('music-lyrics-indicator', this._indicator);
            // 右侧时锚定右边缘，同理避免跳动
            this._setMenuAlignment(1.0);
        }

        // 此时控件已挂到 panel，能取到主题前景色
        this._indicator.refreshControlIcons();
    }

    // 手动 add_child 到 panel 的 box 会绕过 PanelMenu.Button 的菜单对齐逻辑，
    // 默认 0.5（以指示器中心对齐）会让菜单随歌词长度变化左右移动。
    _setMenuAlignment(alignment) {
        try {
            this._indicator.menu.setSourceAlignment(alignment);
        } catch (e) {
            logError(e, 'Failed to set menu source alignment');
        }
    }
}
