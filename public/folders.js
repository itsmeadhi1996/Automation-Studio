'use strict';

// Shared folder paths and relationships for QA Studio and Automation Studio.
(() => {
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  // "Parent / Child". Stops at a repeated id, so a damaged hierarchy cannot hang the page.
  function path(folders, id) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const names = [];
    const seen = new Set();
    let current = id;
    while (current && byId.has(current) && !seen.has(current)) {
      seen.add(current);
      const folder = byId.get(current);
      names.unshift(folder.name);
      current = folder.parentId;
    }
    return names.join(' / ');
  }

  // Depth-first, so each folder appears directly under its parent in a select.
  function choices(folders) {
    const result = [];
    const seen = new Set();
    function visit(parentId) {
      for (const folder of folders) {
        if ((folder.parentId || null) !== parentId || seen.has(folder.id)) continue;
        seen.add(folder.id);
        result.push({ id: folder.id, name: path(folders, folder.id) });
        visit(folder.id);
      }
    }
    visit(null);
    return result;
  }

  // Includes the folder itself. Iterating a Set also visits ids added during the loop.
  function descendants(folders, id) {
    const ids = new Set([id]);
    for (const parent of ids) {
      for (const folder of folders) {
        if (folder.parentId === parent) ids.add(folder.id);
      }
    }
    return ids;
  }

  // "Add File" is the agreed label for creating a folder.
  function addMenu(folderId, name, caseAction) {
    const folder = escapeHtml(folderId);
    return (
      `<details class="folder-add">` +
      `<summary aria-label="Add to ${escapeHtml(name)}" title="Add">＋</summary>` +
      `<div class="folder-menu">` +
      `<button type="button" data-action="new-folder" data-folder="${folder}" title="Create a folder">Add File</button>` +
      `<button type="button" data-action="${escapeHtml(caseAction)}" data-folder="${folder}">Add Test Case</button>` +
      `</div>` +
      `</details>`
    );
  }

  globalThis.StudioFolders = Object.freeze({ path, choices, descendants, addMenu });

  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll('.folder-add[open]')) {
      if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const menu of document.querySelectorAll('.folder-add[open]')) {
      menu.open = false;
      menu.querySelector('summary').focus();
      event.preventDefault();
    }
  });
})();
