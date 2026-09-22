import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import './local-pane'
import './ipod-pane'
import './metadata-dialog'
import type { LocalPane } from './local-pane'
import type { IpodPane } from './ipod-pane'
import './tags-dialog'
import type { FileMetadata, Selection, TagsPreview } from './types'
import { runJob } from './progress'

@customElement('wizard-app')
export class WizardApp extends LitElement {
  @state() private dialogOpen = false
  @state() private metadata: FileMetadata | null = null
  @state() private metadataError = ''
  @state() private organizeExports = false
  @state() private ipodArtwork = true
  @state() private status = ''
  @state() private tagging = false
  @state() private tagsDialogOpen = false
  @state() private tagsPreview: TagsPreview | null = null
  @state() private tagsError = ''
  private previewRequest = 0
  @state() private albumDelimiter = ''
  @state() private artistDelimiter = ''
  // Selection of whichever pane announced one last (the "active" pane).
  @state() private selection: Selection | null = null

  static styles = css`
    :host {
      display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto minmax(0, 1fr); height: 100%;
      font-family: 'Inter', -apple-system, sans-serif; background: #0f0f11; color: #e8e8ec;
      box-sizing: border-box; overflow: hidden;
    }
    .menubar {
      grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 6px 12px;
      background: #1b1b21; border-bottom: 1px solid #2a2a33;
    }
    .menubar button {
      background: #26262e; border: 1px solid #2a2a33; color: #a0a0b0; cursor: pointer;
      font: inherit; font-size: .78rem; padding: 4px 10px; border-radius: 6px;
    }
    .menubar .hint { margin-left: auto; font-size: .72rem; color: #6d6d80; }
    .menubar button:hover { color: #fff; }
    .menubar button:disabled { opacity: .45; cursor: default; color: #a0a0b0; }
    .menubar .status { font-size: .75rem; color: #a78bfa; }
    .menubar button[aria-pressed='true'] { background: #2b2545; border-color: #7c3aed; color: #e8e8ec; }
  `

  connectedCallback() {
    super.connectedCallback()
    try {
      this.organizeExports = localStorage.getItem('organizeExports') === '1'
      this.ipodArtwork = localStorage.getItem('ipodArtwork') !== '0' // on unless switched off
      this.albumDelimiter = localStorage.getItem('albumDelimiter') ?? ''
      this.artistDelimiter = localStorage.getItem('artistDelimiter') ?? ''
    } catch {
      // storage unavailable - keep the default
    }
    window.addEventListener('keydown', this.onKeyDown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this.onKeyDown)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.tagsDialogOpen) {
      this.closeTagsDialog()
    } else if (e.key === 'F3') {
      e.preventDefault()
      if (this.dialogOpen) this.closeDialog()
      else if (!this.tagsDialogOpen) void this.showMetadata()
    } else if (e.key === 'F5') {
      e.preventDefault() // don't reload the page
      if (!this.dialogOpen && !this.tagsDialogOpen) void this.copySelected()
    } else if (e.key === 'Escape' && this.dialogOpen) {
      this.closeDialog()
    }
  }

  private onSelectionChange(e: CustomEvent<Selection>) {
    this.selection = e.detail
  }

  /** F5: copy the active pane's selection to the other pane. */
  private async copySelected() {
    const sel = this.selection
    if (!sel) return
    if (sel.kind === 'local') {
      await this.renderRoot.querySelector<IpodPane>('ipod-pane')?.importFiles(sel.paths)
    } else {
      await this.renderRoot.querySelector<LocalPane>('local-pane')?.exportTracks(sel.ids)
    }
  }

  private toggleOrganize() {
    this.organizeExports = !this.organizeExports
    try {
      localStorage.setItem('organizeExports', this.organizeExports ? '1' : '0')
    } catch {
      // storage unavailable - the toggle just won't persist
    }
  }

  private toggleIpodArtwork() {
    this.ipodArtwork = !this.ipodArtwork
    try {
      localStorage.setItem('ipodArtwork', this.ipodArtwork ? '1' : '0')
    } catch {
      // storage unavailable - the toggle just won't persist
    }
  }

  /** Saves the embedded cover of each selected local file as Folder.jpg next to it. */
  private async extractCovers() {
    const sel = this.selection
    if (sel?.kind !== 'local' || sel.paths.length === 0) return
    this.status = 'Extracting covers…'
    try {
      const res = await fetch('/api/local/extract-covers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: sel.paths }),
      })
      const data = await res.json()
      if (data.error) {
        this.status = data.error
        return
      }
      this.status = `Covers: ${data.saved} saved, ${data.exists} already existed, ${data.none} without cover`
      await this.renderRoot.querySelector<LocalPane>('local-pane')?.refresh()
    } catch {
      this.status = 'Backend nicht erreichbar'
    }
  }

  private setDelimiter(key: 'albumDelimiter' | 'artistDelimiter', value: string) {
    this[key] = value
    try {
      localStorage.setItem(key, value)
    } catch {
      // storage unavailable - the setting just won't persist
    }
  }

  /** "Set tags from folders": opens the explanation dialog; nothing is changed until it is confirmed. */
  private openTagsDialog() {
    const sel = this.selection
    if (sel?.kind !== 'local' || sel.paths.length === 0 || this.tagging) return
    this.tagsDialogOpen = true
    void this.loadTagsPreview()
  }

  private closeTagsDialog() {
    this.tagsDialogOpen = false
  }

  private onTagsOptionsChange(e: CustomEvent<{ albumDelimiter: string; artistDelimiter: string }>) {
    this.setDelimiter('albumDelimiter', e.detail.albumDelimiter)
    this.setDelimiter('artistDelimiter', e.detail.artistDelimiter)
    void this.loadTagsPreview()
  }

  private async loadTagsPreview() {
    const sel = this.selection
    if (sel?.kind !== 'local') return
    const request = ++this.previewRequest // ignore answers that arrive after a newer request
    this.tagsPreview = null
    this.tagsError = ''
    try {
      const res = await fetch('/api/local/set-tags/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: sel.paths, albumDelimiter: this.albumDelimiter, artistDelimiter: this.artistDelimiter }),
      })
      const data = await res.json()
      if (request !== this.previewRequest) return
      if (data.error) this.tagsError = data.error
      else this.tagsPreview = data
    } catch {
      if (request === this.previewRequest) this.tagsError = 'Backend nicht erreichbar'
    }
  }

  /**
   * Rewrites the ID3 tags of the selected mp3s (folders count as everything inside them) from
   * <artist>/<album>/<file>.mp3 - see backend/src/id3-tags.ts. Only called from the dialog's confirm button.
   */
  private async setTagsFromFolders() {
    const sel = this.selection
    if (sel?.kind !== 'local' || sel.paths.length === 0 || this.tagging) return
    this.tagsDialogOpen = false
    this.tagging = true
    this.status = 'Setting tags…'
    try {
      const { result } = await runJob<{ tagged: number; skipped: number; failed: { path: string; error: string }[] }>(
        '/api/local/set-tags',
        { paths: sel.paths, albumDelimiter: this.albumDelimiter, artistDelimiter: this.artistDelimiter },
        (done, total) => (this.status = `Setting tags ${done}/${total}…`),
      )
      const failed = result.failed.length
      this.status =
        `Tags: ${result.tagged} written` +
        (result.skipped ? `, ${result.skipped} skipped (not in artist/album folders)` : '') +
        (failed ? `, ${failed} failed (${result.failed[0].error})` : '')
      await this.renderRoot.querySelector<LocalPane>('local-pane')?.refresh()
    } catch (err) {
      this.status = err instanceof TypeError ? 'Backend nicht erreichbar' : err instanceof Error ? err.message : String(err)
    } finally {
      this.tagging = false
    }
  }

  private closeDialog() {
    this.dialogOpen = false
  }

  private async showMetadata() {
    const sel = this.selection
    if (!sel) return
    let url: string
    if (sel.kind === 'local') {
      const path = sel.focus ?? sel.paths[0]
      if (!path) return
      url = `/api/local/metadata?path=${encodeURIComponent(path)}`
    } else {
      const id = sel.focus ?? sel.ids[0]
      if (id === undefined) return
      url = `/api/ipod/tracks/${id}/metadata`
    }
    this.metadata = null
    this.metadataError = ''
    this.dialogOpen = true
    try {
      const data = await (await fetch(url)).json()
      if (data.error) this.metadataError = data.error
      else this.metadata = data
    } catch {
      this.metadataError = 'Backend nicht erreichbar'
    }
  }

  render() {
    return html`
      <div class="menubar">
        <button
          aria-pressed=${this.organizeExports}
          @click=${this.toggleOrganize}
          title="When copying from the iPod, put files in Artist/Album subfolders"
        >
          Artist/Album folders: ${this.organizeExports ? 'on' : 'off'}
        </button>
        <button
          aria-pressed=${this.ipodArtwork}
          @click=${this.toggleIpodArtwork}
          title="When copying to the iPod, also store each file's embedded cover in the iPod's artwork database (experimental)"
        >
          Cover art on iPod: ${this.ipodArtwork ? 'on' : 'off'}
        </button>
        <button
          ?disabled=${this.selection?.kind !== 'local' || this.selection.paths.length === 0}
          @click=${this.extractCovers}
          title="Save the embedded cover of the selected files as Folder.jpg in their folder"
        >
          Extract Folder.jpg
        </button>
        <button
          ?disabled=${this.tagging || this.selection?.kind !== 'local' || this.selection.paths.length === 0}
          @click=${this.openTagsDialog}
          title="Set title, album and artist of the selected mp3s from their artist/album/file.mp3 path (shows what will happen first)"
        >
          Set tags from folders…
        </button>
        <span class="status">${this.status}</span>
        <span class="hint">F3 metadata · F5 copy to other pane · Del delete from iPod · Ctrl+A select all · Shift+↑↓/PgUp/PgDn extend</span>
      </div>
      <local-pane .organizeExports=${this.organizeExports} @selection-change=${this.onSelectionChange}></local-pane>
      <ipod-pane .artwork=${this.ipodArtwork} @selection-change=${this.onSelectionChange}></ipod-pane>
      ${this.tagsDialogOpen
        ? html`<tags-dialog
            .preview=${this.tagsPreview}
            .error=${this.tagsError}
            .albumDelimiter=${this.albumDelimiter}
            .artistDelimiter=${this.artistDelimiter}
            @options-change=${this.onTagsOptionsChange}
            @confirm=${this.setTagsFromFolders}
            @close=${this.closeTagsDialog}
          ></tags-dialog>`
        : ''}
      ${this.dialogOpen
        ? html`<metadata-dialog
            .metadata=${this.metadata}
            .error=${this.metadataError}
            @close=${this.closeDialog}
          ></metadata-dialog>`
        : ''}
    `
  }
}
