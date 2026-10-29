const $ = (selector) => document.querySelector(selector);
const DB_NAME = "notebook-core";
const STORE_NAME = "notebook";

let db;
let notes = [];
let activeId = null;
let selectedTag = null;
let selectedFolder = null;
let selectedTrash = false;
let mode = "write";
let isSplit = false;
let historyOpen = false;
let saveTimer;
let installPrompt;
let commandItems = [];
let selectedCommandIndex = 0;
const MAX_VERSIONS = 50;

const createId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const normalizeFolderPath = (path) => String(path || "").split(/[\\/]+/).map((part) => part.trim()).filter((part) => part && part !== "." && part !== "..").join("/");
const normalizeForSimilarity = (text) => String(text || "").toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const noteFolder = (note) => normalizeFolderPath(note.folder);
const timeAgo = (date) => {
  const seconds = (Date.now() - new Date(date)) / 1000;
  if (seconds < 60) return "Edited just now";
  if (seconds < 3600) return `Edited ${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `Edited ${Math.floor(seconds / 3600)} hr ago`;
  return `Edited ${new Date(date).toLocaleDateString()}`;
};
const escapeHtml = (text) => String(text || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => { db = request.result; resolve(); };
    request.onerror = () => reject(request.error);
  });
}

function loadNotes() {
  return new Promise((resolve) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get("notes");
    request.onsuccess = () => { notes = Array.isArray(request.result) ? request.result : []; resolve(); };
    request.onerror = () => resolve();
  });
}

function persistNotes() {
  db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(notes, "notes");
}

function activeNote() {
  return notes.find((note) => note.id === activeId && !note.deletedAt);
}

function liveNotes() {
  return notes.filter((note) => !note.deletedAt);
}

function trashedNotes() {
  return notes.filter((note) => Boolean(note.deletedAt));
}

function findNoteByTitle(title) {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  const matches = liveNotes().filter((note) => note.title.trim().toLocaleLowerCase() === normalizedTitle);
  return matches.length === 1 ? matches[0] : null;
}

function renderList() {
  const activeNotes = liveNotes();
  const trash = trashedNotes();
  const ordered = [...(selectedTrash ? trash : activeNotes)].sort((a, b) =>
    new Date(selectedTrash ? b.deletedAt : b.updatedAt) - new Date(selectedTrash ? a.deletedAt : a.updatedAt)
  );
  const query = $("#noteSearch").value.trim().toLocaleLowerCase();
  const tags = [...new Set(activeNotes.flatMap((note) => Array.isArray(note.tags) ? note.tags : []))].sort((a, b) => a.localeCompare(b));
  const folderCounts = new Map();
  activeNotes.forEach((note) => {
    const parts = noteFolder(note).split("/").filter(Boolean);
    parts.forEach((_, index) => {
      const path = parts.slice(0, index + 1).join("/");
      folderCounts.set(path, (folderCounts.get(path) || 0) + 1);
    });
  });
  const folders = [...folderCounts.keys()].sort((a, b) => a.localeCompare(b));
  if (selectedFolder && !folders.includes(selectedFolder)) selectedFolder = null;
  if (selectedTag && !tags.includes(selectedTag)) selectedTag = null;
  $("#folderNav").innerHTML = `<button class="folder-item ${selectedFolder === null && !selectedTrash ? "selected" : ""}" data-folder="" type="button"><span>All notes</span><strong>${activeNotes.length}</strong></button>${folders.map((path) => {
    const parts = path.split("/");
    const label = parts[parts.length - 1];
    return `<button class="folder-item ${!selectedTrash && path === selectedFolder ? "selected" : ""}" data-folder="${escapeHtml(path)}" style="padding-left:${9 + (parts.length - 1) * 12}px" type="button"><span>${escapeHtml(label)}</span><strong>${folderCounts.get(path)}</strong></button>`;
  }).join("")}`;
  $("#folderNav").hidden = selectedTrash;
  $("#tagFilters").hidden = selectedTrash;
  $("#trashToggle").classList.toggle("selected", selectedTrash);
  $("#trashToggle").setAttribute("aria-pressed", String(selectedTrash));
  $("#trashCount").textContent = trash.length;
  $("#noteList").setAttribute("aria-label", selectedTrash ? "Notes in Trash" : "Pinned, recent, and all notes");
  $("#tagFilters").innerHTML = tags.length
    ? `<button class="tag-filter ${selectedTag === null ? "selected" : ""}" data-tag="">All</button>${tags.map((tag) => `<button class="tag-filter ${tag === selectedTag ? "selected" : ""}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("")}`
    : "";
  const visible = ordered.map((note) => {
    const folder = noteFolder(note);
    const matchesFolder = selectedTrash || !selectedFolder || folder === selectedFolder || folder.startsWith(`${selectedFolder}/`);
    const matchesTag = selectedTrash || !selectedTag || (Array.isArray(note.tags) && note.tags.includes(selectedTag));
    const title = String(note.title || "").toLocaleLowerCase();
    const body = String(note.body || "").toLocaleLowerCase();
    const titleMatch = !query || title.includes(query);
    const bodyMatch = !query || body.includes(query);
    return { note, visible: matchesFolder && matchesTag && (titleMatch || bodyMatch), titleMatch };
  }).filter((result) => result.visible)
    .sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch))
    .map((result) => result.note);
  $("#noteCount").textContent = visible.length;
  if (selectedTrash) {
    $("#noteList").innerHTML = visible.length
      ? visible.map((note) => {
        const title = note.title || "Untitled note";
        const deletedAt = new Date(note.deletedAt);
        const dateLabel = Number.isNaN(deletedAt.getTime()) ? "" : `Deleted ${deletedAt.toLocaleDateString()}`;
        return `<article class="trash-item"><div class="trash-note-copy"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(note.body.replace(/\n/g, " ") || "Empty note")}</p><time>${escapeHtml(dateLabel)}</time></div><div class="trash-actions"><button class="restore-note" data-restore-note="${escapeHtml(note.id)}" type="button">Restore</button><button class="delete-forever" data-delete-forever="${escapeHtml(note.id)}" type="button" aria-label="Permanently delete ${escapeHtml(title)}" title="Delete permanently">Delete</button></div></article>`;
      }).join("")
      : `<p class="empty-notes">${query ? "No trashed notes match your search." : "Trash is empty."}</p>`;
    return;
  }
  const renderSection = (label, sectionNotes) => {
    if (!sectionNotes.length) return "";
    return `<section class="note-section"><h2 class="note-section-heading">${label}<span>${sectionNotes.length}</span></h2><div class="note-section-items">${sectionNotes.map((note) => {
      const title = note.title || "Untitled note";
      const pinned = Boolean(note.pinned);
      return `<div class="note-item ${note.id === activeId ? "active" : ""}"><button class="note-open" data-open-note="${escapeHtml(note.id)}" type="button"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(note.body.replace(/\n/g, " ") || "Empty note")}</p>${(Array.isArray(note.tags) ? note.tags : []).length ? `<span class="note-tags">${note.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</span>` : ""}</button><button class="pin-note" data-toggle-pin="${escapeHtml(note.id)}" type="button" aria-label="${pinned ? "Unpin" : "Pin"} ${escapeHtml(title)}" aria-pressed="${pinned}" title="${pinned ? "Unpin note" : "Pin note"}">${pinned ? "★" : "☆"}</button></div>`;
    }).join("")}</div></section>`;
  };
  const pinnedNotes = visible.filter((note) => note.pinned);
  const recentNotes = visible.filter((note) => note.lastOpenedAt)
    .sort((a, b) => new Date(b.lastOpenedAt) - new Date(a.lastOpenedAt))
    .slice(0, 5);
  const allNotes = [...visible].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || new Date(b.updatedAt) - new Date(a.updatedAt));
  $("#noteList").innerHTML = `${renderSection("Pinned", pinnedNotes)}${renderSection("Recent", recentNotes)}${renderSection("All notes", allNotes)}${visible.length ? "" : `<p class="empty-notes">${query ? "No notes match your search." : "No notes in this view."}</p>`}`;
}

function markdown(source) {
  let html = escapeHtml(source);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>").replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>").replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`).replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[\[([^\]]+)\]\]/g, (match, title, offset, input) => {
    const before = input.slice(0, offset);
    if (before.lastIndexOf("<code>") > before.lastIndexOf("</code>")) return match;
    const target = findNoteByTitle(title);
    return target
      ? `<button class="wiki-link" type="button" data-note-id="${escapeHtml(target.id)}">${escapeHtml(title.trim())}</button>`
      : `<span class="wiki-link broken">${escapeHtml(title.trim())}</span>`;
  });
  return html.split(/\n{2,}/).map((block) => /^<(h\d|ul|pre|blockquote)/.test(block) ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`).join("");
}

function renderBacklinks(note, titleText = note.title) {
  const title = titleText.trim().toLocaleLowerCase();
  const incoming = title ? liveNotes().filter((candidate) =>
    candidate.id !== note.id && [...candidate.body.matchAll(/\[\[([^\]]+)\]\]/g)]
      .some((match) => match[1].trim().toLocaleLowerCase() === title)
  ) : [];
  const container = $("#backlinks");
  container.hidden = incoming.length === 0;
  container.innerHTML = incoming.length
    ? `<h2>Linked mentions <span>${incoming.length}</span></h2><div class="backlink-list">${incoming.map((source) => `<button class="backlink-item" type="button" data-note-id="${escapeHtml(source.id)}">${escapeHtml(source.title || "Untitled note")}</button>`).join("")}</div>`
    : "";
}

function renderVersionHistory(note) {
  const container = $("#versionHistory");
  const versions = Array.isArray(note.history) ? note.history : [];
  container.hidden = !historyOpen;
  $("#versionHistoryToggle").setAttribute("aria-expanded", String(historyOpen));
  if (!historyOpen) return;
  container.innerHTML = versions.length
    ? `<h2>Saved versions <span>${versions.length}</span></h2><div class="version-list">${versions.slice().reverse().map((version, reverseIndex) => {
      const index = versions.length - reverseIndex - 1;
      const savedAt = new Date(version.savedAt);
      const dateLabel = Number.isNaN(savedAt.getTime()) ? "Previous version" : savedAt.toLocaleString();
      const excerpt = version.body.trim().replace(/\s+/g, " ");
      return `<article class="version-item"><div class="version-details"><strong>${escapeHtml(version.title || "Untitled note")}</strong><time>${escapeHtml(dateLabel)}</time><p>${escapeHtml(excerpt || "Empty note")}</p></div><button class="restore-version" type="button" data-version-index="${index}">Restore</button></article>`;
    }).join("")}</div>`
    : `<h2>Version history</h2><p class="history-empty">Previous saved versions will appear here as you edit this note.</p>`;
}

function findSimilarNotes(note, title, body) {
  const currentBody = normalizeForSimilarity(body);
  const currentTokens = new Set(normalizeForSimilarity(`${title} ${body}`).split(/\s+/).filter(Boolean));
  if (!currentBody && !currentTokens.size) return [];
  return liveNotes().map((candidate) => {
    if (candidate.id === note.id) return null;
    const candidateBody = normalizeForSimilarity(candidate.body);
    const candidateTokens = new Set(normalizeForSimilarity(`${candidate.title} ${candidate.body}`).split(/\s+/).filter(Boolean));
    if (!candidateBody && !candidateTokens.size) return null;
    let score = currentBody && currentBody === candidateBody ? 1 : 0;
    if (currentTokens.size >= 5 && candidateTokens.size >= 5) {
      let overlap = 0;
      currentTokens.forEach((token) => { if (candidateTokens.has(token)) overlap += 1; });
      score = Math.max(score, (2 * overlap) / (currentTokens.size + candidateTokens.size));
    }
    return score >= 0.82 ? { note: candidate, score } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 3);
}

function renderDuplicateWarning(note, title = note.title, body = note.body) {
  const warning = $("#duplicateWarning");
  const matches = findSimilarNotes(note, title, body);
  warning.hidden = matches.length === 0;
  warning.innerHTML = matches.length
    ? `<strong>This note looks similar to:</strong><div class="duplicate-matches">${matches.map(({ note: match }) => `<button class="duplicate-match" type="button" data-note-id="${escapeHtml(match.id)}">${escapeHtml(match.title || "Untitled note")}</button>`).join("")}</div>`
    : "";
}

function renderGraph() {
  const canvas = $("#graphCanvas");
  const activeNotes = liveNotes();
  if (!activeNotes.length) {
    $("#graphSummary").textContent = "0 notes";
    canvas.innerHTML = `<p class="graph-empty">Create a note to start building your graph.</p>`;
    return;
  }
  const ordered = [...activeNotes].sort((a, b) => a.title.localeCompare(b.title));
  const width = 1000;
  const height = 700;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = ordered.length === 1 ? 0 : Math.min(290, Math.max(130, ordered.length * 9));
  const nodeRadius = ordered.length > 50 ? 8 : 13;
  const positions = new Map(ordered.map((note, index) => {
    const angle = ordered.length === 1 ? 0 : (index / ordered.length) * Math.PI * 2 - Math.PI / 2;
    return [note.id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    }];
  }));
  const links = [];
  const seenLinks = new Set();
  ordered.forEach((source) => {
    for (const match of source.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = findNoteByTitle(match[1]);
      if (!target || target.id === source.id) continue;
      const key = `${source.id}\u0000${target.id}`;
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      links.push({ source, target });
    }
  });
  const connected = new Set(links.flatMap((link) => [link.source.id, link.target.id]));
  $("#graphSummary").textContent = `${ordered.length} ${ordered.length === 1 ? "note" : "notes"} · ${links.length} ${links.length === 1 ? "connection" : "connections"}`;
  const edgeMarkup = links.map(({ source, target }) => {
    const from = positions.get(source.id);
    const to = positions.get(target.id);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const startX = from.x + (dx / length) * nodeRadius;
    const startY = from.y + (dy / length) * nodeRadius;
    const endX = to.x - (dx / length) * (nodeRadius + 5);
    const endY = to.y - (dy / length) * (nodeRadius + 5);
    return `<line class="graph-edge" x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}"><title>${escapeHtml(source.title)} links to ${escapeHtml(target.title)}</title></line>`;
  }).join("");
  const nodeMarkup = ordered.map((note) => {
    const position = positions.get(note.id);
    const title = note.title.trim() || "Untitled note";
    return `<g class="graph-node ${connected.has(note.id) ? "connected" : "unconnected"}" data-note-id="${escapeHtml(note.id)}" role="button" tabindex="0" aria-label="Open note: ${escapeHtml(title)}"><title>${escapeHtml(title)}</title><circle cx="${position.x}" cy="${position.y}" r="${nodeRadius}"></circle><text class="graph-node-label" x="${position.x}" y="${position.y + nodeRadius + 18}">${escapeHtml(title)}</text></g>`;
  }).join("");
  canvas.innerHTML = `<svg class="graph-svg ${ordered.length > 40 ? "dense" : ""}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Graph of ${ordered.length} notes and ${links.length} connections"><defs><marker id="graphArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>${edgeMarkup}${nodeMarkup}</svg>${ordered.length > 40 ? `<p class="graph-hint">Select a dot to open its note. Hover over a dot to see its title.</p>` : ""}`;
}

function openGraph() {
  saveImmediately();
  renderGraph();
  $("#graphDialog").showModal();
}

function openNote(noteId) {
  const note = liveNotes().find((item) => item.id === noteId);
  if (!note) return;
  saveImmediately();
  activeId = note.id;
  note.lastOpenedAt = new Date().toISOString();
  historyOpen = false;
  $("#tagInput").value = "";
  persistNotes();
  render();
}

function togglePinned(noteId) {
  const note = liveNotes().find((item) => item.id === noteId);
  if (!note) return;
  note.pinned = !note.pinned;
  persistNotes();
  renderList();
  toast(note.pinned ? "Note pinned" : "Note unpinned");
}

function renderCommandResults() {
  const query = $("#commandSearch").value.trim().toLocaleLowerCase();
  const current = activeNote();
  const commands = [
    { label: "Create a new note", detail: "Start writing in a new note", keywords: "new create note", shortcut: "Ctrl N", run: createNote },
    { label: "Search notes", detail: "Find a note in your notebook", keywords: "search find notes", shortcut: "", run: () => { $("#noteSearch").focus(); } },
    { label: "Open note graph", detail: "View connections between notes", keywords: "graph links connections", shortcut: "", run: openGraph },
    { label: "Export all notes", detail: "Download a JSON backup", keywords: "export backup json", shortcut: "", run: exportBackup },
    { label: "Import a backup", detail: "Restore notes from a JSON file", keywords: "import backup json", shortcut: "", run: () => $("#backupFile").click() },
    { label: "Import Markdown", detail: "Add a note from a .md file", keywords: "import markdown md file", shortcut: "", run: () => $("#markdownFile").click() },
    ...(current ? [
      { label: current.pinned ? "Unpin current note" : "Pin current note", detail: current.title || "Untitled note", keywords: "pin favorite current note", shortcut: "", run: () => togglePinned(current.id) },
      { label: "Export current note as Markdown", detail: current.title || "Untitled note", keywords: "export markdown md current", shortcut: "", run: exportMarkdown },
      { label: mode === "preview" ? "Switch to Write view" : "Switch to Preview", detail: "Change the current editor view", keywords: "write preview editor view", shortcut: "", run: () => { mode = mode === "preview" ? "write" : "preview"; isSplit = false; renderEditor(); } },
      { label: isSplit ? "Close split view" : "Show split view", detail: "Show writing and preview together", keywords: "split preview editor", shortcut: "", run: () => { isSplit = !isSplit; mode = "write"; renderEditor(); } }
    ] : [])
  ];
  const matchingCommands = commands.filter((command) =>
    !query || `${command.label} ${command.detail} ${command.keywords}`.toLocaleLowerCase().includes(query)
  );
  const matchingNotes = query
    ? liveNotes().filter((note) => `${note.title} ${note.body}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(String(b.title).toLocaleLowerCase().includes(query)) - Number(String(a.title).toLocaleLowerCase().includes(query)) || new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 8)
      .map((note) => ({
        label: note.title || "Untitled note",
        detail: note.body.replace(/\s+/g, " ").slice(0, 90) || "Empty note",
        keywords: "",
        shortcut: "",
        run: () => openNote(note.id)
      }))
    : [];
  commandItems = [...matchingCommands, ...matchingNotes];
  if (!commandItems.length) {
    selectedCommandIndex = 0;
    $("#commandSearch").removeAttribute("aria-activedescendant");
    $("#commandResults").innerHTML = `<p class="command-empty">No matching commands or notes.</p>`;
    return;
  }
  selectedCommandIndex = Math.min(selectedCommandIndex, commandItems.length - 1);
  $("#commandResults").innerHTML = commandItems.map((item, index) =>
    `<button class="command-result ${index === selectedCommandIndex ? "selected" : ""}" data-command-index="${index}" id="command-result-${index}" type="button" role="option" aria-selected="${index === selectedCommandIndex}"><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>${item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : ""}</button>`
  ).join("");
  $("#commandSearch").setAttribute("aria-activedescendant", `command-result-${selectedCommandIndex}`);
}

function openCommandPalette() {
  saveImmediately();
  $("#commandSearch").value = "";
  selectedCommandIndex = 0;
  renderCommandResults();
  $("#commandDialog").showModal();
  $("#commandSearch").focus();
}

function runCommand(index) {
  const command = commandItems[index];
  if (!command) return;
  $("#commandDialog").close();
  command.run();
}

function renderEditor() {
  const note = activeNote();
  $("#welcome").hidden = Boolean(note);
  $("#editor").hidden = !note;
  if (!note) return;
  $("#noteTitle").value = note.title;
  $("#noteBody").value = note.body;
  $("#folderInput").value = noteFolder(note);
  $("#tagList").innerHTML = (Array.isArray(note.tags) ? note.tags : []).map((tag) => `<button class="tag-chip" type="button" data-remove-tag="${escapeHtml(tag)}" aria-label="Remove tag ${escapeHtml(tag)}">${escapeHtml(tag)} <span aria-hidden="true">×</span></button>`).join("");
  $("#editedAt").textContent = timeAgo(note.updatedAt);
  renderDuplicateWarning(note);
  $("#wordCount").textContent = `${note.body.trim() ? note.body.trim().split(/\s+/).length : 0} words`;
  $("#preview").innerHTML = markdown(note.body);
  renderBacklinks(note);
  renderVersionHistory(note);
  $("#compose").className = `compose ${isSplit ? "split" : ""} ${mode === "preview" ? "preview-only" : ""}`;
  document.querySelectorAll(".tab").forEach((tab) => { const selected = tab.dataset.view === mode; tab.classList.toggle("active", selected); tab.setAttribute("aria-selected", selected); });
}

function render() {
  renderList();
  renderEditor();
}

function createNote() {
  const createdAt = new Date().toISOString();
  const note = { id: createId(), title: "", body: "", tags: [], folder: selectedFolder || "", history: [], createdAt, updatedAt: createdAt, lastOpenedAt: createdAt };
  notes.push(note);
  activeId = note.id;
  historyOpen = false;
  selectedTag = null;
  $("#tagInput").value = "";
  persistNotes();
  render();
  $("#noteTitle").focus();
}

function saveCurrent() {
  const note = activeNote();
  if (!note) return;
  const title = $("#noteTitle").value;
  const body = $("#noteBody").value;
  if (title !== note.title || body !== note.body) {
    if (note.title.trim() || note.body.trim()) {
      note.history = Array.isArray(note.history) ? note.history : [];
      note.history.push({ title: note.title, body: note.body, savedAt: note.updatedAt });
      note.history = note.history.slice(-MAX_VERSIONS);
    }
    note.title = title;
    note.body = body;
    note.updatedAt = new Date().toISOString();
  }
  persistNotes();
  $("#saveState").textContent = "Saved locally";
  renderList();
  renderEditor();
}

function saveImmediately() {
  if (!activeNote()) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveCurrent();
}

function restoreVersion(index) {
  const note = activeNote();
  const versions = note && Array.isArray(note.history) ? note.history : [];
  const version = versions[index];
  if (!note || !version) return;
  const selectedVersion = { ...version };
  if (!confirm(`Restore "${selectedVersion.title || "Untitled note"}"? The current version will remain in history.`)) return;
  saveImmediately();
  const current = activeNote();
  current.history = Array.isArray(current.history) ? current.history : [];
  if (current.title.trim() || current.body.trim()) {
    current.history.push({ title: current.title, body: current.body, savedAt: current.updatedAt });
    current.history = current.history.slice(-MAX_VERSIONS);
  }
  current.title = selectedVersion.title;
  current.body = selectedVersion.body;
  current.updatedAt = new Date().toISOString();
  persistNotes();
  $("#saveState").textContent = "Saved locally";
  render();
  toast("Version restored");
}

function scheduleSave() {
  clearTimeout(saveTimer);
  $("#saveState").textContent = "Saving locally…";
  saveTimer = setTimeout(saveCurrent, 300);
}

function removeCurrent() {
  const note = activeNote();
  if (!note || !confirm("Delete this note?")) return;
  saveImmediately();
  note.deletedAt = new Date().toISOString();
  activeId = null;
  selectedTrash = true;
  persistNotes();
  render();
  toast("Moved to Trash");
}

function restoreTrashedNote(noteId) {
  const note = notes.find((item) => item.id === noteId && item.deletedAt);
  if (!note) return;
  note.deletedAt = "";
  persistNotes();
  render();
  toast("Note restored");
}

function deleteTrashedNote(noteId) {
  const note = notes.find((item) => item.id === noteId && item.deletedAt);
  if (!note || !confirm(`Permanently delete "${note.title || "Untitled note"}"? This cannot be undone.`)) return;
  notes = notes.filter((item) => item.id !== noteId);
  persistNotes();
  render();
  toast("Note permanently deleted");
}

function toggleTrashView() {
  saveImmediately();
  selectedTrash = !selectedTrash;
  if (selectedTrash) {
    activeId = null;
    selectedTag = null;
    selectedFolder = null;
    historyOpen = false;
  }
  render();
}

function updateTags(update) {
  const note = activeNote();
  if (!note) return;
  clearTimeout(saveTimer);
  saveCurrent();
  note.tags = Array.isArray(note.tags) ? note.tags : [];
  update(note.tags);
  note.updatedAt = new Date().toISOString();
  persistNotes();
  $("#saveState").textContent = "Saved locally";
  render();
}

function moveNoteToFolder(value) {
  const note = activeNote();
  if (!note) return;
  clearTimeout(saveTimer);
  saveCurrent();
  note.folder = normalizeFolderPath(value);
  note.updatedAt = new Date().toISOString();
  persistNotes();
  $("#saveState").textContent = "Saved locally";
  render();
}

function exportBackup() {
  saveImmediately();
  const backup = {
    app: "Notebook",
    version: 1,
    exportedAt: new Date().toISOString(),
    notes
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `notebook-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${notes.length} ${notes.length === 1 ? "note" : "notes"}`);
}

function downloadTextFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMarkdown() {
  const note = activeNote();
  if (!note) return;
  saveImmediately();
  const title = note.title.trim() || "Untitled note";
  const filename = `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/[. ]+$/g, "") || "Untitled note"}.md`;
  downloadTextFile(filename, `# ${title}\n\n${note.body}`, "text/markdown;charset=utf-8");
  toast("Exported Markdown note");
}

async function importMarkdown(file) {
  if (!file) return;
  if (!/\.md$/i.test(file.name)) {
    toast("Choose a Markdown (.md) file");
    return;
  }
  try {
    saveImmediately();
    const text = await file.text();
    const heading = text.match(/^#\s+(.+)\s*(?:\r?\n|$)/);
    const filenameTitle = file.name.replace(/\.md$/i, "").trim();
    const title = heading ? heading[1].trim() : filenameTitle || "Untitled note";
    const body = heading ? text.slice(heading[0].length).replace(/^\r?\n/, "") : text;
    const createdAt = new Date().toISOString();
    const note = {
      id: createId(),
      title,
      body,
      tags: [],
      folder: selectedFolder || "",
      history: [],
      createdAt,
      updatedAt: createdAt,
      lastOpenedAt: createdAt
    };
    notes.push(note);
    activeId = note.id;
    historyOpen = false;
    selectedTag = null;
    persistNotes();
    render();
    $("#noteTitle").focus();
    toast("Imported Markdown note");
  } catch {
    toast("Could not import Markdown file");
  }
}

function validateBackup(data) {
  if (!data || data.app !== "Notebook" || data.version !== 1 || !Array.isArray(data.notes)) {
    throw new Error("This file is not a supported Notebook backup.");
  }
  const ids = new Set();
  return data.notes.map((note) => {
    if (!note || typeof note !== "object" || typeof note.id !== "string" || !note.id.trim() ||
      typeof note.title !== "string" || typeof note.body !== "string" ||
      (note.tags !== undefined && (!Array.isArray(note.tags) || note.tags.some((tag) => typeof tag !== "string"))) ||
      (note.folder !== undefined && typeof note.folder !== "string") ||
      (note.pinned !== undefined && typeof note.pinned !== "boolean") ||
      (note.lastOpenedAt !== undefined && typeof note.lastOpenedAt !== "string") ||
      (note.deletedAt !== undefined && typeof note.deletedAt !== "string") ||
      (note.history !== undefined && (!Array.isArray(note.history) || note.history.some((version) =>
        !version || typeof version.title !== "string" || typeof version.body !== "string" ||
        typeof version.savedAt !== "string"
      )))) {
      throw new Error("The backup contains an invalid note.");
    }
    if (ids.has(note.id)) throw new Error("The backup contains duplicate note IDs.");
    ids.add(note.id);
    return {
      ...note,
      tags: Array.isArray(note.tags) ? note.tags : [],
      folder: normalizeFolderPath(note.folder),
      history: Array.isArray(note.history) ? note.history.slice(-MAX_VERSIONS) : [],
      pinned: note.pinned === true,
      lastOpenedAt: typeof note.lastOpenedAt === "string" ? note.lastOpenedAt : "",
      deletedAt: typeof note.deletedAt === "string" ? note.deletedAt : "",
      createdAt: typeof note.createdAt === "string" ? note.createdAt : new Date().toISOString(),
      updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : new Date().toISOString()
    };
  });
}

async function importBackup(file) {
  if (!file) return;
  let importedNotes;
  try {
    importedNotes = validateBackup(JSON.parse(await file.text()));
  } catch (error) {
    toast(error instanceof SyntaxError ? "Could not read backup JSON" : error.message);
    return;
  }
  if (!confirm(`Replace all ${notes.length} current notes with ${importedNotes.length} imported notes? This cannot be undone.`)) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const transaction = db.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put(importedNotes, "notes");
  transaction.oncomplete = () => {
    notes = importedNotes;
    activeId = null;
    historyOpen = false;
    selectedTag = null;
    selectedFolder = null;
    $("#noteSearch").value = "";
    $("#saveState").textContent = "Saved locally";
    render();
    toast(`Imported ${notes.length} ${notes.length === 1 ? "note" : "notes"}`);
  };
  transaction.onabort = () => toast("Could not save imported notes to local storage");
}

function addTag(value) {
  const tag = value.trim();
  if (!tag) return;
  updateTags((tags) => {
    if (!tags.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) tags.push(tag);
  });
  $("#tagInput").value = "";
  $("#tagInput").focus();
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(element.timer);
  element.timer = setTimeout(() => { element.hidden = true; }, 2200);
}

$("#newNote").onclick = $("#newNoteTop").onclick = $("#welcomeNewNote").onclick = createNote;
$("#deleteNote").onclick = removeCurrent;
$("#noteTitle").oninput = () => {
  scheduleSave();
  const note = activeNote();
  if (note) {
    renderBacklinks(note, $("#noteTitle").value);
    renderDuplicateWarning(note, $("#noteTitle").value, $("#noteBody").value);
  }
};
$("#noteBody").oninput = () => {
  scheduleSave();
  $("#preview").innerHTML = markdown($("#noteBody").value);
  const note = activeNote();
  if (note) renderDuplicateWarning(note, $("#noteTitle").value, $("#noteBody").value);
};
$("#noteSearch").oninput = renderList;
$("#exportBackup").onclick = exportBackup;
$("#importBackup").onclick = () => $("#backupFile").click();
$("#exportMarkdown").onclick = exportMarkdown;
$("#importMarkdown").onclick = () => $("#markdownFile").click();
$("#backupFile").onchange = (event) => {
  importBackup(event.currentTarget.files[0]);
  event.currentTarget.value = "";
};
$("#markdownFile").onchange = (event) => {
  importMarkdown(event.currentTarget.files[0]);
  event.currentTarget.value = "";
};
$("#tagInput").onkeydown = (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addTag(event.currentTarget.value);
  }
};
$("#folderInput").onkeydown = (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    moveNoteToFolder(event.currentTarget.value);
  }
};
$("#tagList").onclick = (event) => {
  const chip = event.target.closest("[data-remove-tag]");
  if (chip) updateTags((tags) => { const index = tags.indexOf(chip.dataset.removeTag); if (index !== -1) tags.splice(index, 1); });
};
$("#tagFilters").onclick = (event) => {
  const filter = event.target.closest("[data-tag]");
  if (filter) { selectedTag = filter.dataset.tag || null; renderList(); }
};
$("#folderNav").onclick = (event) => {
  const folder = event.target.closest("[data-folder]");
  if (folder) {
    selectedTrash = false;
    selectedFolder = folder.dataset.folder || null;
    render();
  }
};
$("#trashToggle").onclick = toggleTrashView;
$("#openCommandPalette").onclick = openCommandPalette;
$("#commandSearch").oninput = () => { selectedCommandIndex = 0; renderCommandResults(); };
$("#commandSearch").onkeydown = (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!commandItems.length) return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    selectedCommandIndex = (selectedCommandIndex + direction + commandItems.length) % commandItems.length;
    renderCommandResults();
  } else if (event.key === "Enter") {
    event.preventDefault();
    runCommand(selectedCommandIndex);
  }
};
$("#commandResults").onclick = (event) => {
  const result = event.target.closest("[data-command-index]");
  if (result) runCommand(Number(result.dataset.commandIndex));
};
$("#commandDialog").onclick = (event) => {
  if (event.target === $("#commandDialog")) $("#commandDialog").close();
};
$("#openGraph").onclick = openGraph;
$("#closeGraph").onclick = () => $("#graphDialog").close();
$("#graphDialog").onclick = (event) => {
  if (event.target === $("#graphDialog")) $("#graphDialog").close();
};
$("#graphCanvas").onclick = (event) => {
  const node = event.target.closest("[data-note-id]");
  if (!node || !notes.some((note) => note.id === node.dataset.noteId)) return;
  $("#graphDialog").close();
  openNote(node.dataset.noteId);
};
$("#graphCanvas").onkeydown = (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-note-id]")) {
    event.preventDefault();
    event.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
};
$("#versionHistoryToggle").onclick = () => {
  saveImmediately();
  historyOpen = !historyOpen;
  renderEditor();
};
$("#versionHistory").onclick = (event) => {
  const button = event.target.closest("[data-version-index]");
  if (button) restoreVersion(Number(button.dataset.versionIndex));
};
$("#duplicateWarning").onclick = (event) => {
  const button = event.target.closest("[data-note-id]");
  if (!button || !notes.some((note) => note.id === button.dataset.noteId)) return;
  openNote(button.dataset.noteId);
};
$("#preview").onclick = (event) => {
  const link = event.target.closest("[data-note-id]");
  if (!link || !notes.some((note) => note.id === link.dataset.noteId)) return;
  openNote(link.dataset.noteId);
};
$("#backlinks").onclick = (event) => {
  const link = event.target.closest("[data-note-id]");
  if (!link || !notes.some((note) => note.id === link.dataset.noteId)) return;
  openNote(link.dataset.noteId);
};
$("#noteList").onclick = (event) => {
  const restore = event.target.closest("[data-restore-note]");
  if (restore) {
    restoreTrashedNote(restore.dataset.restoreNote);
    return;
  }
  const deleteForever = event.target.closest("[data-delete-forever]");
  if (deleteForever) {
    deleteTrashedNote(deleteForever.dataset.deleteForever);
    return;
  }
  const pin = event.target.closest("[data-toggle-pin]");
  if (pin) {
    togglePinned(pin.dataset.togglePin);
    return;
  }
  const item = event.target.closest("[data-open-note]");
  if (item) openNote(item.dataset.openNote);
};
document.querySelectorAll(".tab").forEach((tab) => { tab.onclick = () => { mode = tab.dataset.view; isSplit = false; renderEditor(); }; });
$("#splitView").onclick = () => { isSplit = !isSplit; mode = "write"; renderEditor(); };
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#commandDialog").open) {
    $("#commandDialog").close();
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    if ($("#commandDialog").open) $("#commandDialog").close();
    else openCommandPalette();
  } else if (event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveImmediately();
  } else if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    createNote();
  }
});
window.addEventListener("beforeunload", () => { if (saveTimer) { clearTimeout(saveTimer); saveCurrent(); } });

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("#installApp").hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("#installApp").hidden = true;
  toast("Notebook installed");
});
$("#installApp").onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  $("#installApp").hidden = true;
  if (outcome === "accepted") toast("Notebook installed");
};

(async () => {
  try {
    await openDatabase();
    await loadNotes();
    render();
  }
  catch (error) {
    console.error("Could not initialize Notebook:", error);
    $("#saveState").textContent = "Browser storage is unavailable";
    toast("Could not initialize Notebook");
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("Could not register offline app support:", error);
      toast("Offline app support is unavailable");
    });
  }
})();
