import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import './local-pane'
import './ipod-pane'
import './metadata-dialog'
import type { FileMetadata, Selection } from './types'

@customElement('wizard-app')
export class WizardApp extends LitElement {
  @state() private dialogOpen = false
  @state() private metadata: FileMetadata | null = null
  @state() private metadataError = ''
  @state() private selection: Selection | null = null
  @state() private organizeExports = false

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
    .menubar button:hover { color: #fff; }
    .menubar button[aria-pressed='true'] { background: #2b2545; border-color: #7c3aed; color: #e8e8ec; }
  `

  connectedCallback() {
    super.connectedCallback()
    try {
      this.organizeExports = localStorage.getItem('organizeExports') === '1'
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
    if (e.key === 'F3') {
      e.preventDefault()
      if (this.dialogOpen) this.closeDialog()
      else void this.showMetadata()
    } else if (e.key === 'Escape' && this.dialogOpen) {
      this.closeDialog()
    }
  }

  private onSelectionChange(e: CustomEvent<Selection | null>) {
    this.selection = e.detail
  }

  private toggleOrganize() {
    this.organizeExports = !this.organizeExports
    try {
      localStorage.setItem('organizeExports', this.organizeExports ? '1' : '0')
    } catch {
      // storage unavailable - the toggle just won't persist
    }
  }

  private closeDialog() {
    this.dialogOpen = false
  }

  private async showMetadata() {
    const sel = this.selection
    if (!sel) return
    const url =
      sel.kind === 'local'
        ? `/api/local/metadata?path=${encodeURIComponent(sel.path)}`
        : `/api/ipod/tracks/${sel.id}/metadata`
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
      </div>
      <local-pane
        .selection=${this.selection}
        .organizeExports=${this.organizeExports}
        @selection-change=${this.onSelectionChange}
      ></local-pane>
      <ipod-pane .selection=${this.selection} @selection-change=${this.onSelectionChange}></ipod-pane>
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
