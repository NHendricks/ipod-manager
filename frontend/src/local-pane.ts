import { LitElement, html, css } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { LocalEntry, Selection } from './types'
import { DRAG_LOCAL_FILE, DRAG_IPOD_TRACK } from './types'

@customElement('local-pane')
export class LocalPane extends LitElement {
  @property({ attribute: false }) selection: Selection | null = null
  @state() private currentDir = ''
  @state() private parent: string | null = null
  @state() private entries: LocalEntry[] = []
  @state() private error = ''
  @state() private dragOver = false
  @state() private busy = false

  static styles = css`
    :host {
      display: flex; flex-direction: column; height: 100%; min-height: 0;
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
    li.dir { cursor: pointer; color: #cbd5f5; }
    li .icon { width: 1.2em; text-align: center; opacity: .8; }
    li .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li .size { color: #6d6d80; font-size: .75rem; flex-shrink: 0; }
    li:not(.audio):not(.dir) { opacity: .45; }
    .dropzone { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .dropzone.drop-target { outline: 2px dashed #7c3aed; outline-offset: -2px; }
    .empty, .error { padding: 24px; text-align: center; color: #6d6d80; font-size: .85rem; }
    .error { color: #f77; }
    .busy { padding: 6px 12px; font-size: .75rem; color: #a78bfa; }
  `

  connectedCallback() {
    super.connectedCallback()
    this.load()
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
      this.currentDir = data.dir
      this.parent = data.parent
      this.entries = data.entries
      this.error = ''
    } catch {
      this.error = 'Backend nicht erreichbar'
    }
  }

  private onEntryClick(entry: LocalEntry) {
    if (entry.isDir) {
      this.emitSelection(null)
      this.load(entry.path)
    } else {
      this.emitSelection({ kind: 'local', path: entry.path })
    }
  }

  private emitSelection(selection: Selection | null) {
    this.dispatchEvent(new CustomEvent('selection-change', { detail: selection, bubbles: true, composed: true }))
  }

  private isSelected(entry: LocalEntry): boolean {
    return this.selection?.kind === 'local' && this.selection.path === entry.path
  }

  private onDragStart(e: DragEvent, entry: LocalEntry) {
    if (entry.isDir || !e.dataTransfer) return
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(DRAG_LOCAL_FILE, entry.path)
    e.dataTransfer.setData('text/plain', entry.path)
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
    const trackId = e.dataTransfer?.getData(DRAG_IPOD_TRACK)
    if (!trackId) return
    e.preventDefault()
    this.busy = true
    try {
      const res = await fetch(`/api/ipod/tracks/${trackId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destDir: this.currentDir }),
      })
      const data = await res.json()
      if (data.error) this.error = data.error
      else await this.load(this.currentDir)
    } finally {
      this.busy = false
    }
  }

  render() {
    return html`
      <header>
        <button class="icon" ?disabled=${!this.parent} @click=${() => this.parent && this.load(this.parent)} title="Up">⬆</button>
        <h2>Your Computer</h2>
      </header>
      <div class="path" title=${this.currentDir}>${this.currentDir}</div>
      ${this.busy ? html`<div class="busy">Exporting…</div>` : ''}
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
                  (entry) => html`
                    <li
                      class=${[entry.isDir ? 'dir' : '', entry.isAudio ? 'audio' : '', this.isSelected(entry) ? 'selected' : ''].join(' ')}
                      draggable=${!entry.isDir}
                      @dragstart=${(e: DragEvent) => this.onDragStart(e, entry)}
                      @click=${() => this.onEntryClick(entry)}
                    >
                      <span class="icon">${entry.isDir ? '📁' : entry.isAudio ? '🎵' : '📄'}</span>
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
