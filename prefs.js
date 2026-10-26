import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpotLinePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();

        // --- Layout Group ---
        const layoutGroup = new Adw.PreferencesGroup({ title: 'Layout' });

        // Position
        const positionRow = new Adw.ComboRow({
            title: 'Panel Position',
            subtitle: 'Where to show lyrics in the top bar',
            model: new Gtk.StringList({ strings: ['Left', 'Center', 'Right'] })
        });
        const positions = ['left', 'center', 'right'];
        positionRow.selected = positions.indexOf(settings.get_string('position-in-panel'));
        positionRow.connect('notify::selected', () => {
            settings.set_string('position-in-panel', positions[positionRow.selected]);
        });
        layoutGroup.add(positionRow);

        // Max text length
        const textLenRow = new Adw.SpinRow({
            title: 'Max Text Length',
            subtitle: 'Maximum number of characters',
            adjustment: new Gtk.Adjustment({
                lower: 10, upper: 200, step_increment: 5,
                value: settings.get_int('max-text-length')
            })
        });
        textLenRow.connect('notify::value', () => {
            settings.set_int('max-text-length', textLenRow.get_value());
        });
        layoutGroup.add(textLenRow);

        // Max width
        const maxWidthRow = new Adw.SpinRow({
            title: 'Max Width (px)',
            subtitle: 'Maximum display width in pixels',
            adjustment: new Gtk.Adjustment({
                lower: 200, upper: 2000, step_increment: 50,
                value: settings.get_int('max-width')
            })
        });
        maxWidthRow.connect('notify::value', () => {
            settings.set_int('max-width', maxWidthRow.get_value());
        });
        layoutGroup.add(maxWidthRow);

        // Font size
        const fontSizeRow = new Adw.SpinRow({
            title: 'Font Size (px)',
            subtitle: 'Lyrics font size',
            adjustment: new Gtk.Adjustment({
                lower: 10, upper: 30, step_increment: 1,
                value: settings.get_int('font-size')
            })
        });
        fontSizeRow.connect('notify::value', () => {
            settings.set_int('font-size', fontSizeRow.get_value());
        });
        layoutGroup.add(fontSizeRow);

        page.add(layoutGroup);

        // --- Appearance Group ---
        const appearGroup = new Adw.PreferencesGroup({ title: 'Appearance' });

        // Show lyrics toggle
        const showLyricsRow = new Adw.SwitchRow({
            title: 'Show Lyrics',
            subtitle: 'Off: show the track title in the top bar instead of lyrics'
        });
        showLyricsRow.active = settings.get_boolean('show-lyrics');
        showLyricsRow.connect('notify::active', () => {
            settings.set_boolean('show-lyrics', showLyricsRow.active);
        });
        appearGroup.add(showLyricsRow);

        // Karaoke toggle
        const karaokeRow = new Adw.SwitchRow({
            title: 'Karaoke Effect',
            subtitle: 'Enable color sweep animation'
        });
        karaokeRow.active = settings.get_boolean('karaoke-enabled');
        karaokeRow.connect('notify::active', () => {
            settings.set_boolean('karaoke-enabled', karaokeRow.active);
        });
        appearGroup.add(karaokeRow);

        // Highlight color
        const highlightRow = new Adw.ActionRow({
            title: 'Highlight Color',
            subtitle: 'Karaoke sweep color'
        });
        const highlightBtn = new Gtk.ColorButton();
        const hlColor = new Gdk.RGBA();
        hlColor.parse(settings.get_string('highlight-color'));
        highlightBtn.set_rgba(hlColor);
        highlightBtn.set_valign(Gtk.Align.CENTER);
        highlightBtn.connect('color-set', () => {
            const c = highlightBtn.get_rgba();
            const hex = '#' +
                Math.round(c.red * 255).toString(16).padStart(2, '0') +
                Math.round(c.green * 255).toString(16).padStart(2, '0') +
                Math.round(c.blue * 255).toString(16).padStart(2, '0');
            settings.set_string('highlight-color', hex);
        });
        highlightRow.add_suffix(highlightBtn);
        appearGroup.add(highlightRow);

        // Base color
        const baseRow = new Adw.ActionRow({
            title: 'Base Color',
            subtitle: 'Unsung lyrics color'
        });
        const baseBtn = new Gtk.ColorButton({ use_alpha: true });
        const baseColor = new Gdk.RGBA();
        baseColor.parse(settings.get_string('base-color'));
        baseBtn.set_rgba(baseColor);
        baseBtn.set_valign(Gtk.Align.CENTER);
        baseBtn.connect('color-set', () => {
            const c = baseBtn.get_rgba();
            settings.set_string('base-color', c.to_string());
        });
        baseRow.add_suffix(baseBtn);
        appearGroup.add(baseRow);

        page.add(appearGroup);
        window.add(page);
    }
}
