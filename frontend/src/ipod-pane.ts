import { LitElement, html, css } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { IpodStatus, IpodTrack, Selection } from './types'
import { DRAG_LOCAL_FILE, DRAG_IPOD_TRACK } from './types'
import { ListSelection } from './list-selection'
import './reset-dialog'
import './firmware-dialog'
import './repair-dialog'
import { renderProgress, progressStyles, runJob, type Progress } from './progress'

@customElement('ipod-pane')
export class IpodPane extends LitElement {
  private sel = new ListSelection()
  @state() private status: IpodStatus = { connected: false }
  @state() private tracks: IpodTrack[] = []
  @state() private filter = ''
  @state() private error = ''
  @state() private dragOver = false
  @state() private progress: Progress | null = null
  @state() private resetDialogOpen = false
  @state() private firmwareDialogOpen = false
  @state() private repairDialogOpen = false
  @state() private ejecting = false
  /** A non-fatal hint shown under the header (e.g. covers that could not be stored). */
  @state() private notice = ''
  /** The iPod was just ejected from here: it is gone from Windows now, and safe to unplug. */
  @state() private ejected = false
  /** Also write embedded covers into the iPod's artwork database when copying (set by the app menubar). */
  @property({ type: Boolean }) artwork = false
  private pollHandle?: ReturnType<typeof setInterval>
  private polling = false

  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; background: #16161a; outline: none; }
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
    tbody tr.selected { background: #2b2545; }
    :host(:focus) tbody tr.cursor { box-shadow: inset 0 0 0 1px #7c3aed; }
    tbody tr { user-select: none; }
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
    header button.plain {
      background: none; border: 1px solid #2a2a33; color: #a0a0b0; cursor: pointer; font: inherit; font-size: .75rem;
      padding: 2px 10px; border-radius: 6px;
    }
    header button.plain:hover:not(:disabled) { background: #26262e; color: #fff; }
    header button.plain:disabled { opacity: .4; cursor: default; }
    .ejected { color: #a8f3c8; }
    .notice { padding: 6px 12px; font-size: .75rem; color: #f3c98b; background: #2a2116; flex-shrink: 0; }
    .status button.warn {
      background: #3a2a1a; border: 1px solid #7a5a2a; color: #f3c98b; cursor: pointer; font: inherit;
      font-size: .72rem; padding: 0 8px; border-radius: 6px;
    }
    .status button.warn:hover { background: #4a3a22; }
    header button.danger {
      background: none; border: 1px solid #5a2a2a; color: #e88; cursor: pointer; font: inherit; font-size: .75rem;
      padding: 2px 10px; border-radius: 6px;
    }
    header button.danger:hover:not(:disabled) { background: #3a1a1a; color: #faa; }
    header button.danger:disabled { opacity: .4; cursor: default; }
    ${progressStyles}
  `

  connectedCallback() {
    super.connectedCallback()
    this.tabIndex = 0
    this.addEventListener('keydown', this.onKeyDown)
    this.refreshStatus()
    this.pollHandle = setInterval(() => this.refreshStatus(), 3000)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.removeEventListener('keydown', this.onKeyDown)
    if (this.pollHandle) clearInterval(this.pollHandle)
  }

  private async refreshStatus() {
    // The backend runs iPod commands one at a time, so during a long copy/delete a poll would just
    // wait in line - don't stack up more of them.
    if (this.polling) return
    this.polling = true
    try {
      const res = await fetch('/api/ipod/status')
      const data: IpodStatus = await res.json()
      const wasConnected = this.status.connected
      this.status = data
      if (data.connected) this.ejected = false
      if (data.connected && !wasConnected) await this.loadTracks()
      if (!data.connected) this.tracks = []
    } catch {
      this.status = { connected: false }
    } finally {
      this.polling = false
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

  private get ids(): string[] {
    return this.filteredTracks.map((t) => String(t.id))
  }

  private onRowClick(e: MouseEvent, index: number) {
    this.sel.click(this.ids, index, e.shiftKey, e.ctrlKey || e.metaKey)
    this.selectionChanged()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Leave typing in the filter box (and Ctrl+A in it) alone.
    if (this.resetDialogOpen || this.firmwareDialogOpen || this.repairDialogOpen || e.composedPath()[0] instanceof HTMLInputElement) return
    if (this.sel.handleKey(e, this.ids, this.pageSize())) {
      e.preventDefault()
      this.selectionChanged()
    } else if (e.key === 'Delete') {
      e.preventDefault()
      const ids = new Set(this.selectedIds)
      void this.deleteTracks(this.tracks.filter((t) => ids.has(t.id)))
    }
  }

  private pageSize(): number {
    const list = this.renderRoot.querySelector('.list')
    const row = this.renderRoot.querySelector('tbody tr')
    return list && row ? Math.max(1, Math.floor(list.clientHeight / (row as HTMLElement).offsetHeight)) : 10
  }

  private selectionChanged() {
    this.emitSelection()
    this.requestUpdate()
    void this.updateComplete.then(() => this.renderRoot.querySelector('tr.cursor')?.scrollIntoView({ block: 'nearest' }))
  }

  /** Selected track ids, in list order, skipping ones that are gone or filtered out. */
  private get selectedIds(): number[] {
    return this.filteredTracks.filter((t) => this.sel.selected.has(String(t.id))).map((t) => t.id)
  }

  private emitSelection() {
    const cursorTrack = this.filteredTracks[this.sel.cursor]
    const detail: Selection = { kind: 'ipod', ids: this.selectedIds, focus: cursorTrack?.id ?? null }
    this.dispatchEvent(new CustomEvent('selection-change', { detail, bubbles: true, composed: true }))
  }

  private onDragStart(e: DragEvent, track: IpodTrack) {
    if (!e.dataTransfer) return
    // Dragging a selected row drags the whole selection; dragging an unselected one just that track.
    const ids = this.sel.selected.has(String(track.id)) ? this.selectedIds : [track.id]
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(DRAG_IPOD_TRACK, JSON.stringify(ids))
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
    const localPaths = e.dataTransfer.getData(DRAG_LOCAL_FILE)
    if (localPaths) {
      paths.push(...(JSON.parse(localPaths) as string[]))
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
    await this.importFiles(paths)
  }

  /** Copies local audio files onto the iPod (drag & drop, or F5 from the local pane). */
  async importFiles(paths: string[]): Promise<void> {
    if (paths.length === 0 || !this.status.connected || this.progress) return

    this.notice = ''
    let failure = ''
    this.progress = { label: 'Copying to iPod', done: 0, total: paths.length }
    try {
      const { results } = await runJob<{ results: { error?: string; coverSkipped?: boolean }[] }>(
        '/api/ipod/tracks',
        { filePaths: paths, artwork: this.artwork },
        (done, total) => (this.progress = { label: 'Copying to iPod', done, total }),
      )
      failure = results.find((r) => r.error)?.error ?? ''
      const skipped = results.filter((r) => r.coverSkipped).length
      if (skipped > 0) {
        this.notice =
          `${skipped} cover${skipped === 1 ? '' : 's'} could not be stored on the iPod: it has no model information. ` +
          'Use "Repair…" in the status line, then copy again.'
      }
    } catch (err) {
      failure = errorMessage(err)
    } finally {
      this.progress = null
    }
    await this.loadTracks()
    await this.refreshStatus()
    if (failure) this.error = failure
  }

  /** Safely removes the iPod (like "Eject" in Explorer); afterwards it can be unplugged. */
  private async ejectIpod(): Promise<void> {
    if (this.ejecting || this.progress) return
    this.ejecting = true
    let failure = ''
    try {
      const data = await (await fetch('/api/ipod/eject', { method: 'POST' })).json()
      if (data.error) failure = data.error
      else this.ejected = true
    } catch (err) {
      failure = errorMessage(err)
    } finally {
      this.ejecting = false
    }
    this.sel.clear()
    await this.refreshStatus()
    if (failure) {
      await this.loadTracks()
      this.error = failure
    }
    this.emitSelection()
  }

  /** Empties the whole iPod library after the reset dialog was confirmed. */
  private async resetLibrary(): Promise<void> {
    this.resetDialogOpen = false
    if (this.progress) return
    const label = 'Emptying iPod'
    let failure = ''
    this.progress = { label, done: 0, total: 1 }
    try {
      await runJob('/api/ipod/reset', { confirm: 'empty-library' }, (done, total) => (this.progress = { label, done, total }))
    } catch (err) {
      failure = errorMessage(err)
    } finally {
      this.progress = null
    }
    this.sel.clear()
    await this.loadTracks()
    await this.refreshStatus()
    this.emitSelection()
    if (failure) this.error = failure
  }

  /** Deletes tracks from the iPod (database entry and audio file) after asking - this can't be undone. */
  private async deleteTracks(tracks: IpodTrack[]): Promise<void> {
    if (tracks.length === 0 || this.progress) return
    const what =
      tracks.length === 1 ? `"${tracks[0].title ?? '(unknown)'}"` : `${tracks.length} tracks`
    if (!confirm(`Delete ${what} from the iPod? The audio files are removed and this can't be undone.`)) return

    let failure = ''
    this.progress = { label: 'Deleting from iPod', done: 0, total: tracks.length }
    try {
      await runJob(
        '/api/ipod/tracks/delete',
        { ids: tracks.map((t) => t.id) },
        (done, total) => (this.progress = { label: 'Deleting from iPod', done, total }),
      )
    } catch (err) {
      failure = errorMessage(err)
    } finally {
      this.progress = null
    }
    this.sel.clear()
    await this.loadTracks()
    await this.refreshStatus()
    this.emitSelection()
    if (failure) this.error = failure
  }

  private onRemoveClick(track: IpodTrack, e: Event) {
    e.stopPropagation()
    void this.deleteTracks([track])
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
    const sysInfo = this.status.sysInfo
    // libgpod reports "Invalid"/"Unknown" when it can't identify the model (empty SysInfo).
    const modelKnown = !!info?.modelName && info.modelName !== 'Invalid'
    const modelNumber = sysInfo?.modelNumber ?? (info?.modelNumber && info.modelNumber !== 'Invalid' ? info.modelNumber : null)
    return html`
      <header>
        <h2>iPod</h2>
        <button class="plain" @click=${() => (this.firmwareDialogOpen = true)} title="How to restore the iPod's firmware (needs Apple's tool)">
          Firmware…
        </button>
        ${this.status.connected
          ? html`<button
              class="plain"
              ?disabled=${this.ejecting || !!this.progress}
              @click=${this.ejectIpod}
              title="Safely remove the iPod: after this it can be unplugged"
            >
              ${this.ejecting ? 'Ejecting…' : 'Eject'}
            </button>
            <button
              class="danger"
              ?disabled=${!!this.progress}
              @click=${() => (this.resetDialogOpen = true)}
              title="Delete all tracks from the iPod (asks for confirmation)"
            >
              Empty library…
            </button>`
          : ''}
      </header>
      ${this.status.connected
        ? html`
            <div class="status">
              <span><strong>${modelKnown ? info?.modelName : 'iPod'}</strong>${modelKnown && info?.generation !== 'Unknown' ? html` (${info?.generation})` : ''}</span>
              <span title=${modelNumber ? '' : NO_MODEL_HINT}>Model: <strong>${modelNumber ?? 'unknown'}</strong></span>
              ${modelNumber && modelKnown
                ? ''
                : html`<button
                    class="warn"
                    @click=${() => (this.repairDialogOpen = true)}
                    title="Without model information the iPod shows 'No Music' after copying"
                  >
                    Repair…
                  </button>`}
              ${sysInfo?.serialNumber ? html`<span>Serial: ${sysInfo.serialNumber}</span>` : ''}
              ${sysInfo?.firmwareVersion ? html`<span>Firmware ${sysInfo.firmwareVersion}</span>` : ''}
              <span>${info?.trackCount ?? this.tracks.length} tracks</span>
              ${info ? html`<span>${formatSize(info.freeBytes)} free of ${formatSize(info.totalBytes)}</span>` : ''}
            </div>
            <input
              class="filter"
              type="text"
              placeholder="Filter by title, artist, album…"
              .value=${this.filter}
              @input=${(e: Event) => {
                this.filter = (e.target as HTMLInputElement).value
                this.sel.clear() // cursor/anchor are indexes into the filtered list
                this.emitSelection()
              }}
            />
          `
        : ''}
      ${renderProgress(this.progress)}
      ${this.notice ? html`<div class="notice">${this.notice}</div>` : ''}
      ${this.repairDialogOpen
        ? html`<repair-dialog
            .totalBytes=${this.status.info?.totalBytes ?? 0}
            @repaired=${() => void this.refreshStatus()}
            @close=${() => (this.repairDialogOpen = false)}
          ></repair-dialog>`
        : ''}
      ${this.firmwareDialogOpen
        ? html`<firmware-dialog @close=${() => (this.firmwareDialogOpen = false)}></firmware-dialog>`
        : ''}
      ${this.resetDialogOpen
        ? html`<reset-dialog
            .trackCount=${this.status.info?.trackCount ?? this.tracks.length}
            @close=${() => (this.resetDialogOpen = false)}
            @confirm=${this.resetLibrary}
          ></reset-dialog>`
        : ''}
      <div
        class=${this.dragOver ? 'dropzone drop-target' : 'dropzone'}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        ${!this.status.connected
          ? this.ejected
            ? html`<div class="disconnected ejected">iPod ejected - it is safe to unplug it now.</div>`
            : html`<div class="disconnected">No iPod detected. Connect it in disk mode and it will show up here.</div>`
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
                        (track, index) => html`
                          <tr
                            class=${[
                              this.sel.selected.has(String(track.id)) ? 'selected' : '',
                              index === this.sel.cursor ? 'cursor' : '',
                            ].join(' ')}
                            draggable="true"
                            @click=${(e: MouseEvent) => this.onRowClick(e, index)}
                            @dragstart=${(e: DragEvent) => this.onDragStart(e, track)}
                          >
                            <td>${track.title ?? '(unknown)'}</td>
                            <td>${track.artist ?? ''}</td>
                            <td>${track.album ?? ''}</td>
                            <td class="remove"><button @click=${(e: Event) => this.onRemoveClick(track, e)} title="Remove">×</button></td>
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

const NO_MODEL_HINT =
  "The iPod has no model information (iPod_Control/Device/SysInfo is empty, which happens if it never synced with iTunes). " +
  "Its model number is shown in the iPod's Settings > About."

function errorMessage(err: unknown): string {
  // fetch() rejects with a TypeError when the backend can't be reached; anything else carries the server's message.
  return err instanceof TypeError ? 'Backend nicht erreichbar' : err instanceof Error ? err.message : String(err)
}

function formatSize(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}
