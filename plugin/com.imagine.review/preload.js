const { contextBridge, ipcRenderer } = require('electron/renderer');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('imagine', {
    state: () => invoke('state'),
    onContext: on('context'),
    onEpisode: on('episode'),
    onEvent: on('event'),
    onService: on('service'),
    onToast: on('toast'),

    createNote: (payload) => invoke('note:create', payload),
    listNotes: () => invoke('notes:list'),
    importMarkers: () => invoke('notes:import'),
    jump: (note) => invoke('note:jump', note),
    updateNote: (id, patch) => invoke('note:update', id, patch),
    comment: (id, text) => invoke('note:comment', id, text),

    loadTake: (note) => invoke('take:load', note),
    selectTake: (note, which) => invoke('take:select', note, which),
    acceptTake: (note) => invoke('take:accept', note),
    rejectTake: (note, reason) => invoke('take:reject', note, reason),

    sendNotes: (ids) => invoke('agent:send', ids),
    chat: (text, attachShot) => invoke('agent:chat', text, attachShot),
    cancel: () => invoke('agent:cancel'),
    history: () => invoke('agent:history'),

    authStatus: () => invoke('auth:status'),
    signIn: () => invoke('auth:login'),
    signOut: () => invoke('auth:logout'),
    models: () => invoke('models:list'),
    setModel: (id) => invoke('models:set', id),

    linkEpisode: () => invoke('episode:link'),
    openEpisode: (rel) => invoke('episode:open', rel),
    pin: (on) => invoke('window:pin', on),
    selftest: () => invoke('selftest'),
});
