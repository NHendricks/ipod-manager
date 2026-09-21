import { LitElement, html, css } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'

interface ClassicModel {
  modelNumber: string
  name: string
  capacityGB: number
}

/**
 * Repairs an iPod whose SysInfo is empty: writes model + FireWire GUID into iPod_Control/Device/SysInfo
 * and re-saves the music database signed, which an iPod Classic needs to show any music
 * (otherwise it says "No Music"). Fires "close" and, after a successful repair, "repaired".
 */
@customElement('repair-dialog')
export class RepairDialog extends LitElement {
  /** Size of the iPod's disk, to suggest the models with a matching capacity. */
  @property({ type: Number }) totalBytes = 0
  @state() private guid: string | null = null
  @state() private models: ClassicModel[] = []
  @state() private selected = ''
  @state() private loading = true
  @state() private busy = false
  @state() private error = ''
  @state() private done = false

  static styles = css`
    .backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: flex;
      align-items: center; justify-content: center; z-index: 10;
    }
    .dialog {
      background: #1b1b21; border: 1px solid #2a2a33; border-radius: 12px; width: min(620px, 94vw);
      max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0, 0, 0, .5);
      color: #e8e8ec; font-size: .82rem;
    }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #2a2a33; }
    header h3 { margin: 0; flex: 1; font-size: .95rem; }
    header button { background: none; border: none; color: #a0a0b0; cursor: pointer; font-size: 1.1rem; }
    header button:hover { color: #fff; }
    .body { padding: 12px 16px; overflow-y: auto; line-height: 1.45; }
    .notice {
      background: #1f2a3a; border: 1px solid #2a4a7a; color: #a8c8f3; border-radius: 8px;
      padding: 8px 10px; margin-bottom: 12px;
    }
    .success {
      background: #1a3a26; border: 1px solid #2a7a4a; color: #a8f3c8; border-radius: 8px;
      padding: 8px 10px; margin-bottom: 12px;
    }
    h4 { margin: 14px 0 4px; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: #8a8a9a; }
    h4:first-of-type { margin-top: 0; }
    ul, ol { margin: 0; padding-left: 20px; }
    li { margin: 3px 0; }
    code { background: #26262e; border-radius: 4px; padding: 0 4px; }
    select {
      background: #1f1f27; border: 1px solid #2a2a33; color: #e8e8ec; border-radius: 6px;
      padding: 4px 8px; font: inherit; outline: none; margin-top: 4px; max-width: 100%;
    }
    select:focus { border-color: #7c3aed; }
    .muted { color: #8a8a9a; }
    .error { color: #f77; margin-top: 10px; }
    footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid #2a2a33; }
    footer button {
      background: #26262e; border: 1px solid #2a2a33; color: #e8e8ec; cursor: pointer;
      font: inherit; padding: 5px 14px; border-radius: 6px;
    }
    footer button:hover:not(:disabled) { border-color: #7c3aed; }
    footer button.primary { background: #5b2fc0; border-color: #7c3aed; }
    footer button:disabled { opacity: .45; cursor: default; }
  `

  connectedCallback() {
    super.connectedCallback()
    void this.load()
  }

  private async load() {
    try {
      const data = await (await fetch('/api/ipod/repair-info')).json()
      if (data.error) throw new Error(data.error)
      this.guid = data.firewireGuid
      this.models = data.models
      const gb = this.totalBytes / 1e9
      // Models whose capacity matches the disk size come first (a "160 GB" iPod has ~159.7e9 bytes).
      const matches = (m: ClassicModel) => this.totalBytes > 0 && Math.abs(gb - m.capacityGB) / m.capacityGB < 0.1
      this.models = [...this.models.filter(matches), ...this.models.filter((m) => !matches(m))]
      this.selected = this.models[0]?.modelNumber ?? ''
    } catch (err) {
      this.error = err instanceof TypeError ? 'Backend nicht erreichbar' : err instanceof Error ? err.message : String(err)
    } finally {
      this.loading = false
    }
  }

  private close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }))
  }

  private async repair() {
    if (this.busy || !this.selected || !this.guid) return
    this.busy = true
    this.error = ''
    try {
      const data = await (
        await fetch('/api/ipod/repair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelNumber: this.selected }),
        })
      ).json()
      if (data.error) throw new Error(data.error)
      this.done = true
      this.dispatchEvent(new CustomEvent('repaired', { bubbles: true, composed: true }))
    } catch (err) {
      this.error = err instanceof TypeError ? 'Backend nicht erreichbar' : err instanceof Error ? err.message : String(err)
    } finally {
      this.busy = false
    }
  }

  // Keys typed in the dialog must not reach the app's shortcuts (F5 copy, Del delete, ...).
  private onKeyDown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape' && !this.busy) this.close()
  }

  render() {
    const ready = !this.loading && !!this.guid && !!this.selected
    return html`
      <div
        class="backdrop"
        @click=${(e: Event) => e.target === e.currentTarget && !this.busy && this.close()}
        @keydown=${this.onKeyDown}
      >
        <div class="dialog" role="dialog" aria-label="Repair iPod">
          <header>
            <h3>Repair iPod: model and database signature</h3>
            <button @click=${this.close} ?disabled=${this.busy} title="Close (Esc)">✕</button>
          </header>
          <div class="body">
            ${this.done
              ? html`<div class="success">
                  <strong>Done.</strong> The database was saved with a signature. Eject the iPod in Windows
                  ("Safely remove hardware"), unplug it and check its Music menu.
                </div>`
              : ''}
            <div class="notice">
              An iPod Classic only shows music if its database carries a checksum made from the iPod's
              <strong>FireWire GUID</strong>. This iPod has no model information (<code>SysInfo</code> is empty), so
              this app can't create that checksum yet - after copying, the iPod shows <strong>"No Music"</strong>.
            </div>

            <h4>What happens</h4>
            <ol>
              <li>The <strong>model</strong> you choose below and the iPod's <strong>GUID</strong> are written to
                <code>iPod_Control/Device/SysInfo</code> (an existing non-empty file is kept as <code>SysInfo.bak</code>)</li>
              <li>The music database is <strong>saved again with the signature</strong>
                (<code>iTunesDB.previous.bak</code> is the backup)</li>
              <li>Your music files are not touched. If anything fails, <code>SysInfo</code> is put back as it was</li>
            </ol>

            <h4>Detected</h4>
            ${this.loading
              ? html`<div class="muted">Reading the iPod…</div>`
              : html`<div>FireWire GUID:
                  ${this.guid ? html`<code>${this.guid}</code>` : html`<span class="error">not found</span>`}</div>`}

            <h4>Model</h4>
            <div class="muted">
              Pick the model shown on the iPod under Settings &gt; About. If unsure, one with your capacity is
              fine: the signature is the same for all iPod Classic models.
            </div>
            <select
              .value=${this.selected}
              ?disabled=${this.busy || this.done}
              @change=${(e: Event) => (this.selected = (e.target as HTMLSelectElement).value)}
            >
              ${this.models.map(
                (m) => html`<option value=${m.modelNumber} ?selected=${m.modelNumber === this.selected}>
                  M${m.modelNumber} - iPod ${m.name}, ${m.capacityGB} GB
                </option>`,
              )}
            </select>

            ${this.error ? html`<div class="error">${this.error}</div>` : ''}
          </div>
          <footer>
            <button @click=${this.close} ?disabled=${this.busy}>${this.done ? 'Close' : 'Cancel'}</button>
            ${this.done
              ? ''
              : html`<button class="primary" ?disabled=${!ready || this.busy} @click=${this.repair}>
                  ${this.busy ? 'Repairing…' : 'Repair'}
                </button>`}
          </footer>
        </div>
      </div>
    `
  }
}
