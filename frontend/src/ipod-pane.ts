import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import type { IpodStatus, IpodTrack } from './types'
import { DRAG_LOCAL_FILE, DRAG_IPOD_TRACK } from './types'

@customElement('ipod-pane')
export class IpodPane extends LitElement {
  @state() private status: IpodStatus = { connected: false }
  @state() private tracks: IpodTrack[] = []
  @state() private filter = ''
  @state() private error = ''
  @state() private dragOver = false
  @state() private importProgress = ''
  private pollHandle?: ReturnType<typeof setInterval>

  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; background: #16161a; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid #2a2a33; flex-shrink: 0;
    }
    header h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: #8a8a9a; margin: 0; flex: 1; }
    .status {
      padding: 6px 12px; font-size: .75rem; color: #6d6d80; border-bottom: 1px solid #201f26; flex-shrink: 0;
      display: flex; gap: 12px; flex-wrap: wrap;
    }
    .status strong { color: #cbd5f5; font-weight: 600; }
    input.filter {
      margin: 8px 12px 0; background: #1f1f27; border: 1px solid #2a2a33; color: #e8e8ec;
      border-radius: 8px; padding: 6px 10px; font-size: .8rem; outline: none; flex-shrink: 0;
    }
    input.filter:focus { border-color: #7c3aed; }
    .list { flex: 1; min-height: 0; overflow-y: auto; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    thead th {
      position: sticky; top: 0; background: #16161a; text-align: left; color: #6d6d80;
      font-weight: 500; padding: 4px 10px; border-bottom: 1px solid #2a2a33;
    }
    tbody tr { cursor: default; }
    tbody tr:hover { background: #1f1f27; }
    tbody td { padding: 5px 10px; color: #d8d8e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 1px; }
    td.remove { width: 1.5em; text-align: center; opacity: 0; }
    tbody tr:hover td.remove { opacity: 1; }
    td.remove button {
      background: none; border: none; color: #f77; cursor: pointer; font-size: .9rem; padding: 0 4px;
    }
    .dropzone { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .dropzone.drop-target { outline: 2px dashed #7c3aed; outline-offset: -2px; }
    .empty, .error, .disconnected { padding: 24px; text-align: center; color: #6d6d80; font-size: .85rem; }
    .error { color: #f77; }
    .progress { padding: 6px 12px; font-size: .75rem; color: #a78bfa; flex-shrink: 0; }
  `

  connectedCallback() {
    super.connectedCallback()
    this.refreshStatus()
    this.pollHandle = setInterval(() => this.refreshStatus(), 3000)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this.pollHandle) clearInterval(this.pollHandle)
  }

  private async refreshStatus() {
    try {
      const res = await fetch('/api/ipod/status')
      const data: IpodStatus = await res.json()
      const wasConnected = this.status.connected
      this.status = data
      if (data.connected && !wasConnected) await this.loadTracks()
      if (!data.connected) this.tracks = []
    } catch {
      this.status = { connected: false }
    }
  }

  private async loadTracks() {
    try {
      const res = await fetch('/api/ipod/tracks')
      const data = await res.json()
      if (data.error) this.error = data.error
      else {
        this.tracks = data.tracks
        this.error = ''
      }
    } catch {
      this.error = 'Backend nicht erreichbar'
    }
  }

  private onDragStart(e: DragEvent, track: IpodTrack) {
    if (!e.dataTransfer) return
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(DRAG_IPOD_TRACK, String(track.id))
    e.dataTransfer.setData('text/plain', `${track.artist ?? ''} - ${track.title ?? ''}`)
  }

  private onDragOver(e: DragEvent) {
    if (!this.status.connected) return
    const types = e.dataTransfer?.types ?? []
    if (!types.includes(DRAG_LOCAL_FILE) && !types.includes('Files')) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.dragOver = true
  }

  private onDragLeave() {
    this.dragOver = false
  }

  private async onDrop(e: DragEvent) {
    this.dragOver = false
    if (!e.dataTransfer) return
    e.preventDefault()

    const paths: string[] = []
    const localPath = e.dataTransfer.getData(DRAG_LOCAL_FILE)
    if (localPath) {
      paths.push(localPath)
    } else if (e.dataTransfer.files.length > 0) {
      for (const file of e.dataTransfer.files) {
        const p = window.ipodBridge?.getPathForFile(file)
        if (p) paths.push(p)
      }
      if (paths.length === 0) {
        this.error = 'Could not resolve dropped file paths (drag-and-drop from Explorer requires the desktop app).'
        return
      }
    }
    if (paths.length === 0) return

    for (let i = 0; i < paths.length; i++) {
      this.importProgress = `Importing ${i + 1}/${paths.length}…`
      try {
        const res = await fetch('/api/ipod/tracks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: paths[i] }),
        })
        const data = await res.json()
        if (data.error) this.error = data.error
      } catch {
        this.error = 'Backend nicht erreichbar'
      }
    }
    this.importProgress = ''
    await this.loadTracks()
    await this.refreshStatus()
  }

  private async removeTrack(track: IpodTrack, e: Event) {
    e.stopPropagation()
    try {
      const res = await fetch(`/api/ipod/tracks/${track.id}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.error) this.error = data.error
      else {
        this.tracks = this.tracks.filter((t) => t.id !== track.id)
        await this.refreshStatus()
      }
    } catch {
      this.error = 'Backend nicht erreichbar'
    }
  }

  private get filteredTracks(): IpodTrack[] {
    const q = this.filter.trim().toLowerCase()
    if (!q) return this.tracks
    return this.tracks.filter((t) =>
      [t.title, t.artist, t.album].some((field) => field?.toLowerCase().includes(q)),
    )
  }

  render() {
    const info = this.status.info
    return html`
      <header>
        <h2>iPod</h2>
      </header>
      ${this.status.connected
        ? html`
            <div class="status">
              <span><strong>${info?.modelName ?? 'iPod'}</strong> (${info?.generation ?? '?'})</span>
              <span>${info?.trackCount ?? this.tracks.length} tracks</span>
              ${info ? html`<span>${formatSize(info.freeBytes)} free of ${formatSize(info.totalBytes)}</span>` : ''}
            </div>
            <input
              class="filter"
              type="text"
              placeholder="Filter by title, artist, album…"
              .value=${this.filter}
              @input=${(e: Event) => (this.filter = (e.target as HTMLInputElement).value)}
            />
          `
        : ''}
      ${this.importProgress ? html`<div class="progress">${this.importProgress}</div>` : ''}
      <div
        class=${this.dragOver ? 'dropzone drop-target' : 'dropzone'}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        ${!this.status.connected
          ? html`<div class="disconnected">No iPod detected. Connect it in disk mode and it will show up here.</div>`
          : this.error
            ? html`<div class="error">${this.error}</div>`
            : this.filteredTracks.length === 0
              ? html`<div class="empty">${this.tracks.length === 0 ? 'No tracks yet - drag audio files here' : 'No matches'}</div>`
              : html`
                <div class="list">
                  <table>
                    <thead>
                      <tr><th>Title</th><th>Artist</th><th>Album</th><th></th></tr>
                    </thead>
                    <tbody>
                      ${this.filteredTracks.map(
                        (track) => html`
                          <tr draggable="true" @dragstart=${(e: DragEvent) => this.onDragStart(e, track)}>
                            <td>${track.title ?? '(unknown)'}</td>
                            <td>${track.artist ?? ''}</td>
                            <td>${track.album ?? ''}</td>
                            <td class="remove"><button @click=${(e: Event) => this.removeTrack(track, e)} title="Remove">×</button></td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                </div>
              `}
      </div>
    `
  }
}

function formatSize(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}
