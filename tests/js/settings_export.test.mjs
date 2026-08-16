import assert from 'node:assert/strict';
import test from 'node:test';


globalThis.Vue = {
    ref(value) { return { value }; },
    reactive(value) { return value; },
};

const { useSettings } = await import('../../web_ui/js/state/useSettings.js');


test('configuration export uses the DBDeck product name', async () => {
    let savedFilename = '';
    globalThis.window = {
        pywebview: {
            api: {
                async save_json(filename) {
                    savedFilename = filename;
                    return { success: true };
                },
            },
        },
    };

    const settings = useSettings({
        dbService: {
            async exportConfig() {
                return { success: true, data: {} };
            },
        },
        notify() {},
        showMessage() {},
        isLoading: { value: false },
        refreshTree() {},
    });

    await settings.exportConfig();

    assert.match(savedFilename, /^dbdeck-config-and-connections-\d+\.json$/);
    delete globalThis.window;
});
