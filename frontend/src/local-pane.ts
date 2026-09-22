import { LitElement, html, css } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { LocalEntry, Selection } from './types'
import { DRAG_LOCAL_FILE, DRAG_IPOD_TRACK } from './types'
import { ListSelection } from './list-selection'
import { renderProgress, progressStyles, runJob, formatTransferReport, type Progress } from './progress'

@customElement('local-pane')
export class LocalPane extends LitElement {
  @property({ type: Boolean }) organizeExports = false
  @state() private currentDir = ''
  @state() private parent: string | null = null
  @state() private entries: LocalEntry[] = []
  @state() private error = ''
  @state() private dragOver = false
  @state() private progress: Progress | null = null
  /** A non-fatal hint shown under the header (e.g. the MB/s report after a copy). */
  @state() private notice = ''
  @state() private coverVersion = 0
  @state() private drives: { path: string; label: string }[] = []
  private lastDirByDrive = new Map<string, string>()
  // Audio files and folders can be selected (a selected folder stands for all audio files inside it
  // when copying to the iPod); other files and the ".." row only get the keyboard cursor.
  private selectablePaths = new Set<string>()
  private sel = new ListSelection((path) => this.selectablePaths.has(path))

  static styles = css`
    :host {
      display: flex; flex-direction: column; height: 100%; min-height: 0; outline: none;
      background: #16161a; border-right: 1px solid #2a2a33;
    }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid #2a2a33; flex-shrink: 0;
    }
    header h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: #8a8a9a; margin: 0; flex: 1; }
    button.icon {
      background: none; border: none; color: #a0a0b0; cursor: pointer; font-size: 1rem;
      padding: 2px 8px; border-radius: 6px;
    }
    button.icon:disabled { opacity: .4; cursor: default; }
    select.drives {
      background: #1f1f27; border: 1px solid #2a2a33; color: #e8e8ec; border-radius: 6px;
      padding: 2px 6px; font: inherit; font-size: .8rem; outline: none;
    }
    select.drives:focus { border-color: #7c3aed; }
    button.icon.label { font: inherit; font-size: .8rem; white-space: nowrap; }
    button.icon:hover { background: #26262e; color: #fff; }
    .path {
      padding: 6px 12px; font-size: .75rem; color: #6d6d80; border-bottom: 1px solid #201f26;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;
    }
    ul { list-style: none; margin: 0; padding: 4px; overflow-y: auto; flex: 1; min-height: 0; }
    li {
      display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px;
      cursor: default; font-size: .85rem; color: #d8d8e0; user-select: none;
    }
    li:hover { background: #1f1f27; }
    li.selected { background: #2b2545; }
    :host(:focus) li.cursor { box-shadow: inset 0 0 0 1px #7c3aed; }
    li.dir { cursor: pointer; color: #cbd5f5; }
    /* The cover <img> sits on top of the glyph, hidden (but laid out, so lazy loading still fires)
       until it has loaded - files without embedded art keep showing the glyph. */
    li .thumb { position: relative; width: 2.2em; height: 2.2em; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    li .glyph { opacity: .8; }
    li .thumb img {
      position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: 3px;
      visibility: hidden;
    }
    li .thumb img.loaded { visibility: visible; }
    li .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li .size { color: #6d6d80; font-size: .75rem; flex-shrink: 0; }
    li:not(.audio):not(.dir) { opacity: .45; }
    .dropzone { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .dropzone.drop-target { outline: 2px dashed #7c3aed; outline-offset: -2px; }
    .empty, .error { padding: 24px; text-align: center; color: #6d6d80; font-size: .85rem; }
    .error { color: #f77; }
    .notice { padding: 6px 12px; font-size: .75rem; color: #a78bfa; flex-shrink: 0; }
    ${progressStyles}
  `

  connectedCallback() {
    super.connectedCallback()
    this.tabIndex = 0
    this.addEventListener('keydown', this.onKeyDown)
    void this.loadDrives()
    this.load()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.removeEventListener('keydown', this.onKeyDown)
  }

  /** Drive letter of the current folder, e.g. "D:" (empty for paths without one). */
  private get currentDrive(): string {
    return /^[A-Za-z]:/.test(this.currentDir) ? this.currentDir.slice(0, 2).toUpperCase() : ''
  }

  private async loadDrives(): Promise<void> {
    try {
      this.drives = (await (await fetch('/api/local/drives')).json()).drives ?? []
    } catch {
      // keep the list we have
    }
  }

  /** Jumps to the drive's last visited folder, or its root the first time. */
  private switchDrive(root: string): void {
    const drive = root.slice(0, 2).toUpperCase()
    void this.load(drive === this.currentDrive ? root : (this.lastDirByDrive.get(drive) ?? root))
  }

  private async load(dir?: string): Promise<void> {
    try {
      const url = dir ? `/api/local/list?dir=${encodeURIComponent(dir)}` : '/api/local/home'
      const res = await fetch(url)
      const data = await res.json()
      if (data.error) {
        this.error = data.error
        return
      }
      if (!dir) {
        return this.load(data.dir)
      }
      const previousDir = this.currentDir
      this.currentDir = data.dir
      this.lastDirByDrive.set(this.currentDrive, data.dir)
      this.parent = data.parent
      // ".." is a real (folder) row so arrows/Enter/click treat it like any other folder.
      const up: LocalEntry[] = data.parent
        ? [{ name: '..', path: data.parent, isDir: true, sizeBytes: 0, isAudio: false }]
        : []
      this.entries = [...up, ...data.entries]
      this.selectablePaths = new Set(
        this.entries.filter((e) => e.isAudio || (e.isDir && e.name !== '..')).map((e) => e.path),
      )
      // Only announce if there was something to clear - a reload (e.g. after an export) shouldn't
      // steal "active pane" status from the iPod pane.
      const hadSelection = this.sel.selected.size > 0
      this.sel.clear()
      // Going up: put the cursor back on the folder we just came out of.
      if (previousDir && previousDir !== data.dir && data.parent !== previousDir) {
        this.sel.cursor = this.entries.findIndex((e) => e.path === previousDir)
      }
      if (hadSelection) this.emitSelection()
      this.error = ''
    } catch {
      this.error = 'Backend nicht erreichbar'
    }
  }

  private get ids(): string[] {
    return this.entries.map((e) => e.path)
  }

  private onEntryClick(e: MouseEvent, index: number) {
    const entry = this.entries[index]
    if (entry.isDir && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      this.load(entry.path)
      return
    }
    this.sel.click(this.ids, index, e.shiftKey, e.ctrlKey || e.metaKey)
    this.selectionChanged()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Leave typing in inputs (and browser shortcuts like Ctrl+A in a text field) alone.
    const target = e.composedPath()[0]
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
    if (this.sel.handleKey(e, this.ids, this.pageSize())) {
      e.preventDefault()
      this.selectionChanged()
      return
    }
    const cursorEntry = this.entries[this.sel.cursor]
    if (e.key === 'Enter' && cursorEntry?.isDir) {
      e.preventDefault()
      this.load(cursorEntry.path)
    } else if (e.key === 'Backspace' && this.parent) {
      e.preventDefault()
      this.load(this.parent)
    }
  }

  private pageSize(): number {
    const list = this.renderRoot.querySelector('ul')
    const row = this.renderRoot.querySelector('li')
    return list && row ? Math.max(1, Math.floor(list.clientHeight / row.offsetHeight)) : 10
  }

  private selectionChanged() {
    this.emitSelection()
    this.requestUpdate()
    void this.updateComplete.then(() => this.renderRoot.querySelector('li.cursor')?.scrollIntoView({ block: 'nearest' }))
  }

  private get selectedPaths(): string[] {
    return this.entries.filter((e) => this.sel.selected.has(e.path)).map((e) => e.path)
  }

  private emitSelection() {
    const cursorEntry = this.entries[this.sel.cursor]
    const detail: Selection = {
      kind: 'local',
      paths: this.selectedPaths,
      focus: cursorEntry?.isAudio ? cursorEntry.path : null,
    }
    this.dispatchEvent(new CustomEvent('selection-change', { detail, bubbles: true, composed: true }))
  }

  private onDragStart(e: DragEvent, entry: LocalEntry) {
    if (entry.name === '..' || !e.dataTransfer) return
    // Dragging a selected row drags the whole selection; dragging an unselected one just that file.
    const paths = this.sel.selected.has(entry.path) ? this.selectedPaths : [entry.path]
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(DRAG_LOCAL_FILE, JSON.stringify(paths))
    e.dataTransfer.setData('text/plain', paths.join('\n'))
  }

  private onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes(DRAG_IPOD_TRACK)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    this.dragOver = true
  }

  private onDragLeave() {
    this.dragOver = false
  }

  private async onDrop(e: DragEvent) {
    this.dragOver = false
    const payload = e.dataTransfer?.getData(DRAG_IPOD_TRACK)
    if (!payload) return
    e.preventDefault()
    await this.exportTracks(JSON.parse(payload) as number[])
  }

  /** Re-reads the current folder (e.g. after files were created by an action outside this pane). */
  refresh(): Promise<void> {
    this.coverVersion++ // embedded covers may have changed; thumbnails are otherwise browser-cached
    return this.load(this.currentDir)
  }

  /** Copies iPod tracks into the current folder (drag & drop, or F5 from the iPod pane). */
  async exportTracks(trackIds: number[]): Promise<void> {
    if (this.progress || trackIds.length === 0) return
    const label = 'Copying from iPod'
    let failure = ''
    this.notice = ''
    this.progress = { label, done: 0, total: trackIds.length }
    try {
      const { result, elapsedMs } = await runJob<{ results: { error?: string }[]; bytesTransferred: number }>(
        '/api/ipod/export',
        { ids: trackIds, destDir: this.currentDir, organize: this.organizeExports },
        (done, total, bytesDone, elapsedMs) => (this.progress = { label, done, total, bytesDone, elapsedMs }),
      )
      failure = result.results.find((r) => r.error)?.error ?? ''
      this.notice = formatTransferReport(result.bytesTransferred, elapsedMs)
    } catch (err) {
      // fetch() rejects with a TypeError when the backend can't be reached.
      failure = err instanceof TypeError ? 'Backend nicht erreichbar' : err instanceof Error ? err.message : String(err)
    } finally {
      this.progress = null
    }
    await this.load(this.currentDir)
    if (failure) this.error = failure
  }

  render() {
    return html`
      <header>
        ${this.drives.length > 0
          ? html`<select
              class="drives"
              title="Switch drive (remembers the last folder of each drive)"
              @focus=${this.loadDrives}
              @change=${(e: Event) => this.switchDrive((e.target as HTMLSelectElement).value)}
            >
              ${this.drives.map(
                (d) => html`<option value=${d.path} ?selected=${d.path.slice(0, 2).toUpperCase() === this.currentDrive}>${d.label}</option>`,
              )}
            </select>`
          : ''}
        <button class="icon" ?disabled=${!this.parent} @click=${() => this.parent && this.load(this.parent)} title="Up">⬆</button>
        <button class="icon label" @click=${() => this.load()} title="Go to the standard Music folder">🎵 Music</button>
        <h2>Your Computer</h2>
      </header>
      <div class="path" title=${this.currentDir}>${this.currentDir}</div>
      ${renderProgress(this.progress)}
      ${this.notice ? html`<div class="notice">${this.notice}</div>` : ''}
      <div
        class=${this.dragOver ? 'dropzone drop-target' : 'dropzone'}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        ${this.error
          ? html`<div class="error">${this.error}</div>`
          : this.entries.length === 0
            ? html`<div class="empty">Empty folder</div>`
            : html`
              <ul>
                ${this.entries.map(
                  (entry, index) => html`
                    <li
                      class=${[
                        entry.isDir ? 'dir' : '',
                        entry.isAudio ? 'audio' : '',
                        this.sel.selected.has(entry.path) ? 'selected' : '',
                        index === this.sel.cursor ? 'cursor' : '',
                      ].join(' ')}
                      draggable=${entry.name !== '..'}
                      @dragstart=${(e: DragEvent) => this.onDragStart(e, entry)}
                      @click=${(e: MouseEvent) => this.onEntryClick(e, index)}
                    >
                      <span class="thumb">
                        <span class="glyph">${entry.isDir ? '📁' : entry.isAudio ? '🎵' : '📄'}</span>
                        ${entry.isAudio
                          ? html`<img
                              loading="lazy"
                              alt=""
                              src=${`/api/local/cover?path=${encodeURIComponent(entry.path)}&v=${this.coverVersion}`}
                              @load=${(e: Event) => (e.target as HTMLImageElement).classList.add('loaded')}
                              @error=${(e: Event) => (e.target as HTMLImageElement).classList.remove('loaded')}
                            />`
                          : ''}
                      </span>
                      <span class="name">${entry.name}</span>
                      ${entry.isDir ? '' : html`<span class="size">${formatSize(entry.sizeBytes)}</span>`}
                    </li>
                  `,
                )}
              </ul>
            `}
      </div>
    `
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
