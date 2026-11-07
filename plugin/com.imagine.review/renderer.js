/* global imagine */
'use strict';

const CATEGORIES = ['identity', 'facing', 'hands', 'geometry', 'room', 'words', 'pause', 'continuity', 'lipsync', 'sound', 'pacing', 'grade', 'other'];
const ACTIVE = new Set(['open', 'sent', 'working', 'candidate', 'rejected']);
const DONE = new Set(['accepted', 'closed']);

const state = {
    context: {},
    episode: null,
    notes: [],
    kind: 'regenerate',
    category: 'facing',
    tab: 'notes',
    busy: false,
    loadedTakes: new Set(),
    liveMsg: null,
    pinned: false,
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
}

let toastTimer = null;
function toast(text, level) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast ' + (level || '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, level === 'error' ? 9000 : 4000);
}

/** Calls the main process; shows the error and returns null when it fails. */
async function run(promise, okText) {
    const r = await promise;
    if (!r || !r.ok) {
        toast((r && r.error) || 'Something went wrong.', 'error');
        return null;
    }
    if (okText) toast(okText, 'ok');
    return r.data;
}

function fileUrl(p) {
    return 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function joinPath(dir, rel) {
    return dir.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\');
}

// ---------------------------------------------------------------- header, episode, auth

function renderEpisode() {
    const ep = state.episode;
    const c = state.context;
    $('projectName').textContent = c.projectName || 'No project open in Resolve';
    $('episodeName').textContent = ep ? ep.dir : (c.projectName ? 'Not linked to an episode folder' : '');
    $('linkBtn').hidden = !c.projectName || !!ep;
    $('openFolderBtn').hidden = !ep;
    loadNotes();
    loadHistory();
}

async function refreshAuth() {
    const a = await imagine.authStatus();
    const signedIn = a && a.ok && a.data.status === 'logged-in';
    $('signInBtn').hidden = signedIn;
    $('modelSelect').hidden = !signedIn;
    if (!a || !a.ok) {
        $('authText').textContent = 'Service unavailable';
        return;
    }
    $('authText').textContent = signedIn
        ? 'Cursor: ' + (a.data.email || 'signed in') + (a.data.expiresAt ? ' · key until ' + a.data.expiresAt.slice(0, 10) : '')
        : 'Not signed in to Cursor';
    if (signedIn && !$('modelSelect').options.length) {
        const m = await imagine.models();
        if (m && m.ok) {
            const sel = $('modelSelect');
            sel.replaceChildren(...m.data.models.map((x) => el('option', { value: x.id }, x.displayName || x.id)));
            sel.value = m.data.selected;
        }
    }
}

// ---------------------------------------------------------------- shot card

function parseClip(name) {
    const m = /^([A-Za-z0-9_]+?)-(v\d+)\./.exec(name || '');
    return m ? { sid: m[1], version: m[2] } : null;
}

function renderShot() {
    const c = state.context;
    if (c.error) {
        $('shotSid').textContent = '—';
        $('shotVer').textContent = '';
        $('shotTc').textContent = '';
        $('shotLine').textContent = c.error;
        $('shotMeta').textContent = '';
        return;
    }
    let p = c.clip ? parseClip(c.clip.name) : null;
    if (!p && c.clip && c.shotMarker) {
        const v = /^(v\d+)\./.exec(c.clip.name);
        p = { sid: c.shotMarker.name, version: v ? v[1] : '' };
    }
    $('shotSid').textContent = p ? p.sid : (c.clip ? c.clip.name : '—');
    $('shotVer').textContent = p ? p.version : '';
    $('shotTc').textContent = c.timecode || '';
    const line = c.shotMarker && c.shotMarker.note ? c.shotMarker.note.replace(/^v\d+\s+/, '') : '';
    $('shotLine').textContent = c.clip ? (line || c.clip.name) : (c.timelineName ? 'The playhead is not on a clip.' : 'Open a timeline in Resolve.');
    const meta = [];
    if (c.clip) {
        const notesHere = state.notes.filter((n) => n.timelineItemId === c.clip.id && ACTIVE.has(n.status)).length;
        if (notesHere) meta.push(notesHere + ' open note' + (notesHere > 1 ? 's' : '') + ' on this clip');
        meta.push('frame ' + (c.playhead - c.clip.start + c.clip.leftOffset) + ' of the take');
    }
    const range = c.markIn !== null && c.markIn !== undefined && c.markOut !== null && c.markOut >= c.markIn ? c.markOut - c.markIn + 1 : 0;
    if (range) meta.push('In/Out ' + range + ' frames');
    $('shotMeta').replaceChildren(...meta.map((m) => el('span', null, m)));
    const n = (c.selected || []).length;
    $('selLabel').textContent = n ? 'Selected clips (' + n + ')' : 'Selected clips';
    $('useSelection').disabled = !n;
}

// ---------------------------------------------------------------- composer

function renderComposer() {
    for (const b of $('kindSeg').children) b.classList.toggle('on', b.dataset.kind === state.kind);
    $('catChips').replaceChildren(...CATEGORIES.map((cat) => el('button', {
        class: 'chip' + (cat === state.category ? ' on' : ''),
        onclick: () => { state.category = cat; renderComposer(); },
    }, cat)));
}

async function addNote() {
    const text = $('noteText').value.trim();
    if (!text && state.kind !== 'approve') {
        toast('Write what is wrong first.', 'warn');
        $('noteText').focus();
        return;
    }
    $('addNoteBtn').disabled = true;
    try {
        const created = await run(imagine.createNote({
            kind: state.kind,
            category: state.kind === 'approve' ? 'other' : state.category,
            text: text || 'Approved.',
            useSelection: $('useSelection').checked,
            useRange: $('useRange').checked,
        }));
        if (created) {
            $('noteText').value = '';
            toast('Added ' + created.map((n) => n.id + ' (' + (n.sid || 'timeline') + ')').join(', '), 'ok');
            await loadNotes();
        }
    } finally {
        $('addNoteBtn').disabled = false;
    }
}

// ---------------------------------------------------------------- notes

async function loadNotes() {
    if (!state.episode) {
        state.notes = [];
        renderNotes();
        return;
    }
    const notes = await run(imagine.listNotes());
    if (notes) {
        state.notes = notes;
        renderNotes();
        renderShot();
    }
}

function upsertNote(note) {
    const i = state.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) state.notes[i] = note;
    else state.notes.push(note);
    renderNotes();
}

function noteCard(n) {
    const thumb = n.stills && n.stills.length && state.episode
        ? el('img', { class: 'thumb', src: fileUrl(joinPath(state.episode.dir, n.stills[Math.floor(n.stills.length / 2)])), title: 'Jump to this frame', onclick: () => run(imagine.jump(n)) })
        : el('div', { class: 'thumb none' }, 'no still');
    const sub = [n.timecode, n.durationFrames > 1 ? n.durationFrames + ' frames' : null, n.source === 'harvest' ? 'from a marker' : null].filter(Boolean).join(' · ');
    const actions = el('div', { class: 'note-actions' },
        el('button', { class: 'small', onclick: () => run(imagine.jump(n)) }, 'Jump'),
        (n.status === 'open' || n.status === 'rejected') && n.kind !== 'approve'
            ? el('button', { class: 'small', onclick: () => sendNotes([n.id]) }, 'Send to Cursor') : null,
        n.status !== 'closed' && n.status !== 'accepted'
            ? el('button', { class: 'small ghost', onclick: () => run(imagine.updateNote(n.id, { status: 'closed' })) }, 'Close') : null,
        n.status === 'closed'
            ? el('button', { class: 'small ghost', onclick: () => run(imagine.updateNote(n.id, { status: 'open' })) }, 'Reopen') : null,
    );
    const replyInput = el('input', { placeholder: 'Reply…', 'aria-label': 'Reply to ' + n.id });
    const reply = el('div', { class: 'reply' }, replyInput, el('button', {
        class: 'small',
        onclick: async () => {
            const t = replyInput.value.trim();
            if (t && (await run(imagine.comment(n.id, t)))) replyInput.value = '';
        },
    }, 'Reply'));
    replyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') reply.lastChild.click(); });

    let candidate = null;
    if (n.candidate && n.status === 'candidate') {
        const loaded = state.loadedTakes.has(n.id);
        candidate = el('div', { class: 'candidate' },
            el('div', null, el('b', null, 'New take ' + n.candidate.version), n.candidate.summary ? ' — ' + n.candidate.summary : ''),
            el('div', { class: 'note-actions' },
                !loaded ? el('button', { class: 'small primary', onclick: () => loadTake(n) }, 'Load as take') : null,
                loaded ? el('button', { class: 'small', onclick: () => run(imagine.selectTake(n, 'original')) }, 'Show ' + n.version) : null,
                loaded ? el('button', { class: 'small', onclick: () => run(imagine.selectTake(n, 'candidate')) }, 'Show ' + n.candidate.version) : null,
                loaded ? el('button', { class: 'small primary', onclick: () => acceptTake(n) }, 'Accept') : null,
                el('button', { class: 'small danger', onclick: () => rejectTake(n) }, 'Reject'),
            ));
    }

    return el('div', { class: 'note k-' + n.kind },
        thumb,
        el('div', null,
            el('div', { class: 'note-top' },
                el('span', { class: 'note-id' }, n.id),
                el('span', { class: 'note-shot' }, (n.sid || 'timeline') + (n.version ? ' ' + n.version : '')),
                el('span', { class: 'muted' }, n.kind + ' · ' + n.category),
                el('span', { class: 'pill s-' + n.status }, n.status)),
            el('div', { class: 'note-text' }, n.text),
            sub ? el('div', { class: 'note-sub' }, sub) : null,
            n.attempts && n.attempts.length ? el('div', { class: 'note-sub' }, n.attempts.map((a) => a.version + ' ' + a.verdict + (a.reason ? ' (' + a.reason + ')' : '')).join(' · ')) : null,
            n.comments && n.comments.length ? el('div', { class: 'comments' }, n.comments.map((c) => el('div', { class: 'comment' }, el('b', null, c.by + ': '), c.text))) : null,
            candidate,
            actions,
            reply,
        ));
}

function renderNotes() {
    const filter = $('notesFilter').value;
    const shown = state.notes.filter((n) => filter === 'all' || (filter === 'done' ? DONE.has(n.status) : ACTIVE.has(n.status)));
    const open = state.notes.filter((n) => ACTIVE.has(n.status)).length;
    $('notesCount').textContent = open ? String(open) : '';
    $('sendAllBtn').disabled = !state.notes.some((n) => n.status === 'open' && n.kind !== 'approve');
    const list = $('notesList');
    if (!state.episode) {
        list.replaceChildren(el('div', { class: 'empty' }, state.context.projectName
            ? 'This project is not linked to an episode folder. Use "Link episode folder" above.'
            : 'Open an episode\'s project in Resolve.'));
        return;
    }
    if (!shown.length) {
        list.replaceChildren(el('div', { class: 'empty' }, state.notes.length
            ? 'Nothing here with this filter.'
            : 'No notes yet. Put the playhead on a bad frame, pick what should happen and a category, write the note, and press Add note. Markers you already placed (Red regenerate, Yellow fix, Cyan question, Green approve) come in with Import markers.'));
        return;
    }
    list.replaceChildren(...shown.map(noteCard));
}

async function sendNotes(ids) {
    const r = await run(imagine.sendNotes(ids));
    if (r) {
        toast('Sent ' + r.sent.join(', ') + ' to Cursor.', 'ok');
        switchTab('chat');
    }
}

async function loadTake(n) {
    toast('Loading ' + n.candidate.version + ' into Resolve…');
    const r = await run(imagine.loadTake(n));
    if (r) {
        state.loadedTakes.add(n.id);
        toast(n.candidate.version + ' is take ' + r.selected + ' of ' + r.takes + ' on ' + n.sid + ' (' + r.span.from + (r.audio === false ? '; the dialogue audio did not take' : '') + ').', 'ok');
        renderNotes();
    }
}

async function acceptTake(n) {
    const r = await run(imagine.acceptTake(n), n.sid + ' ' + n.candidate.version + ' accepted; manifest updated.');
    if (r) {
        state.loadedTakes.delete(n.id);
        upsertNote(r);
    }
}

async function rejectTake(n) {
    const box = el('input', { placeholder: 'Why? (sent to the agent with the retry)' });
    const card = [...$('notesList').children].find((c) => c.querySelector('.note-id') && c.querySelector('.note-id').textContent === n.id);
    if (card && !card.querySelector('.reject-box')) {
        const row = el('div', { class: 'reply reject-box' }, box, el('button', {
            class: 'small danger',
            onclick: async () => {
                const r = await run(imagine.rejectTake(n, box.value.trim()), 'Rejected ' + n.candidate.version + '. The note is open again.');
                if (r) {
                    state.loadedTakes.delete(n.id);
                    upsertNote(r);
                }
            },
        }, 'Reject'));
        card.querySelector('.candidate').append(row);
        box.focus();
    }
}

// ---------------------------------------------------------------- chat

function md(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts = String(text).split(/```[a-zA-Z0-9_-]*\n?/);
    return parts.map((p, i) => {
        if (i % 2 === 1) return '<pre><code>' + esc(p.replace(/\n$/, '')) + '</code></pre>';
        return esc(p)
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
            .replace(/^#{1,4}\s+(.+)$/gm, '<div class="head">$1</div>')
            .replace(/^\s*[-*]\s+/gm, '• ')
            .replace(/\n/g, '<br>');
    }).join('');
}

function chatEntry(e) {
    const div = el('div', { class: 'msg ' + e.role });
    if (e.role === 'assistant') div.innerHTML = md(e.text);
    else div.textContent = e.role === 'tool' ? '› ' + e.text : e.text;
    return div;
}

function scrollChat() {
    const log = $('chatLog');
    log.scrollTop = log.scrollHeight;
}

async function loadHistory() {
    if (!state.episode) {
        $('chatLog').replaceChildren(el('div', { class: 'empty' }, 'Open an episode to chat with its repair agent.'));
        return;
    }
    const h = await run(imagine.history());
    if (!h) return;
    state.liveMsg = null;
    $('chatLog').replaceChildren(...(h.entries.length ? h.entries.map(chatEntry) : [el('div', { class: 'empty' },
        'The repair agent works in this episode\'s folder with your pipeline. Ask about a shot, or send notes from the Notes tab.')]));
    setBusy(h.busy);
    scrollChat();
}

function setBusy(b) {
    state.busy = b;
    $('busyDot').hidden = !b;
    $('stopBtn').hidden = !b;
}

async function sendChat() {
    const text = $('chatText').value.trim();
    if (!text) return;
    $('chatText').value = '';
    const log = $('chatLog');
    if (log.querySelector('.empty')) log.replaceChildren();
    log.append(chatEntry({ role: 'user', text }));
    scrollChat();
    setBusy(true);
    const r = await run(imagine.chat(text, $('attachShot').checked));
    if (!r) setBusy(false);
}

function onAgentEvent(ev) {
    const log = $('chatLog');
    if (ev.type === 'agent.text') {
        if (log.querySelector('.empty')) log.replaceChildren();
        if (!state.liveMsg) {
            state.liveMsg = { text: '', node: el('div', { class: 'msg assistant' }) };
            log.append(state.liveMsg.node);
        }
        state.liveMsg.text += ev.text;
        state.liveMsg.node.innerHTML = md(state.liveMsg.text);
        scrollChat();
    } else if (ev.type === 'agent.tool' && (ev.status === 'running')) {
        state.liveMsg = null;
        log.append(chatEntry({ role: 'tool', text: ev.name + (ev.args ? ': ' + ev.args : '') }));
        scrollChat();
    } else if (ev.type === 'agent.status') {
        setBusy(ev.status === 'running' || ev.status === 'starting');
    } else if (ev.type === 'agent.done') {
        state.liveMsg = null;
        setBusy(false);
        if (ev.status === 'error') log.append(chatEntry({ role: 'system', text: 'The run failed: ' + (ev.error || 'unknown error') }));
        if (ev.status === 'cancelled') log.append(chatEntry({ role: 'system', text: 'Stopped.' }));
        scrollChat();
    }
}

// ---------------------------------------------------------------- tabs and wiring

function switchTab(t) {
    state.tab = t;
    $('tabNotes').classList.toggle('on', t === 'notes');
    $('tabChat').classList.toggle('on', t === 'chat');
    $('notesView').hidden = t !== 'notes';
    $('chatView').hidden = t !== 'chat';
    if (t === 'chat') scrollChat();
}

function sameEpisode(ev) {
    return state.episode && ev.episodeDir && ev.episodeDir.toLowerCase() === state.episode.dir.toLowerCase();
}

function wire() {
    for (const b of $('kindSeg').children) {
        b.addEventListener('click', () => { state.kind = b.dataset.kind; renderComposer(); });
    }
    $('addNoteBtn').addEventListener('click', addNote);
    $('noteText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) addNote(); });
    $('tabNotes').addEventListener('click', () => switchTab('notes'));
    $('tabChat').addEventListener('click', () => switchTab('chat'));
    $('notesFilter').addEventListener('change', renderNotes);
    $('sendAllBtn').addEventListener('click', () => sendNotes(undefined));
    $('importBtn').addEventListener('click', async () => {
        const r = await run(imagine.importMarkers());
        if (r) {
            toast('Markers: ' + r.created + ' new note' + (r.created === 1 ? '' : 's') + ', ' + r.updated + ' updated.', 'ok');
            loadNotes();
        }
    });
    $('chatSendBtn').addEventListener('click', sendChat);
    $('chatText').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChat();
        }
    });
    $('stopBtn').addEventListener('click', () => run(imagine.cancel()));
    $('signInBtn').addEventListener('click', async () => {
        const r = await run(imagine.signIn());
        if (r) toast('Finish signing in in your browser.', 'ok');
    });
    $('modelSelect').addEventListener('change', (e) => run(imagine.setModel(e.target.value), 'Model: ' + e.target.value + ' (applies to new agents)'));
    $('linkBtn').addEventListener('click', async () => {
        const ep = await run(imagine.linkEpisode());
        if (ep) {
            state.episode = ep;
            renderEpisode();
        }
    });
    $('openFolderBtn').addEventListener('click', () => run(imagine.openEpisode()));
    $('testBtn').addEventListener('click', async () => {
        $('testBtn').disabled = true;
        toast('Testing markers, clip colors and takes on the clip under the playhead…');
        try {
            const r = await run(imagine.selftest());
            if (r) toast('Self-test passed: ' + r.steps.map((s) => s.name).join(', ') + '.', 'ok');
        } finally {
            $('testBtn').disabled = false;
        }
    });
    $('pinBtn').addEventListener('click', async () => {
        state.pinned = !state.pinned;
        await run(imagine.pin(state.pinned));
        $('pinBtn').classList.toggle('on', state.pinned);
    });

    imagine.onContext((c) => {
        const projectChanged = c.projectName !== state.context.projectName;
        state.context = c;
        renderShot();
        if (projectChanged) renderEpisode();
    });
    imagine.onEpisode((ep) => {
        state.episode = ep;
        renderEpisode();
    });
    imagine.onService((up) => {
        $('svcDot').className = 'dot ' + (up ? 'up' : 'down');
        $('svcDot').title = up ? 'Service connected' : 'Service reconnecting…';
        if (up) refreshAuth();
    });
    imagine.onToast((t) => toast(t.text, t.level));
    imagine.onEvent((ev) => {
        if (ev.type === 'auth.changed') {
            $('modelSelect').replaceChildren();
            refreshAuth();
            if (ev.status === 'logged-in') toast('Signed in to Cursor' + (ev.email ? ' as ' + ev.email : '') + '.', 'ok');
            return;
        }
        if (!sameEpisode(ev)) return;
        if (ev.type === 'note.updated' && ev.note) {
            upsertNote(ev.note);
            renderShot();
        } else if (ev.type === 'take.candidate' && ev.note) {
            toast('New take ' + ev.note.candidate.version + ' for ' + ev.note.id + ' (' + ev.note.sid + '). Load it from the Notes tab.', 'ok');
        } else if (ev.type.startsWith('agent.')) {
            onAgentEvent(ev);
        }
    });
}

async function init() {
    wire();
    renderComposer();
    const s = await imagine.state();
    if (s && s.ok) {
        state.context = s.data.context || {};
        state.episode = s.data.episode;
        $('svcDot').className = 'dot ' + (s.data.health ? 'up' : 'down');
    }
    renderShot();
    renderEpisode();
    refreshAuth();
}

init();
