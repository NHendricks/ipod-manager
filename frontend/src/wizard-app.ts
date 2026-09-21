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

  static styles = css`
    :host {
      display: grid; grid-template-columns: 1fr 1fr; height: 100%;
      font-family: 'Inter', -apple-system, sans-serif; background: #0f0f11; color: #e8e8ec;
      box-sizing: border-box; overflow: hidden;
    }
  `

  connectedCallback() {
    super.connectedCallback()
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
      <local-pane .selection=${this.selection} @selection-change=${this.onSelectionChange}></local-pane>
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
