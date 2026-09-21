import { LitElement, html, css } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'

const CONFIRM_WORD = 'RESET'

/**
 * Confirmation for emptying the whole iPod library. Explains exactly what is deleted and only
 * enables the button once "RESET" has been typed. Fires "close" and "confirm".
 */
@customElement('reset-dialog')
export class ResetDialog extends LitElement {
  @property({ type: Number }) trackCount = 0
  @state() private typed = ''

  static styles = css`
    .backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: flex;
      align-items: center; justify-content: center; z-index: 10;
    }
    .dialog {
      background: #1b1b21; border: 1px solid #2a2a33; border-radius: 12px; width: min(560px, 94vw);
      max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0, 0, 0, .5);
      color: #e8e8ec; font-size: .82rem;
    }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #2a2a33; }
    header h3 { margin: 0; flex: 1; font-size: .95rem; }
    header button { background: none; border: none; color: #a0a0b0; cursor: pointer; font-size: 1.1rem; }
    header button:hover { color: #fff; }
    .body { padding: 12px 16px; overflow-y: auto; line-height: 1.45; }
    .danger {
      background: #3a1a1a; border: 1px solid #7a2a2a; color: #f3a8a8; border-radius: 8px;
      padding: 8px 10px; margin-bottom: 12px;
    }
    h4 { margin: 14px 0 4px; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: #8a8a9a; }
    h4:first-of-type { margin-top: 0; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 2px 0; }
    code { background: #26262e; border-radius: 4px; padding: 0 4px; }
    .confirm { margin-top: 14px; display: flex; align-items: center; gap: 8px; }
    .confirm input {
      width: 8em; background: #1f1f27; border: 1px solid #2a2a33; color: #e8e8ec; border-radius: 6px;
      padding: 4px 8px; font: inherit; outline: none;
    }
    .confirm input:focus { border-color: #b33; }
    footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid #2a2a33; }
    footer button {
      background: #26262e; border: 1px solid #2a2a33; color: #e8e8ec; cursor: pointer;
      font: inherit; padding: 5px 14px; border-radius: 6px;
    }
    footer button:hover:not(:disabled) { border-color: #7c3aed; }
    footer button.danger-button { background: #8a1f1f; border-color: #b33; }
    footer button:disabled { opacity: .45; cursor: default; }
  `

  firstUpdated() {
    this.renderRoot.querySelector<HTMLInputElement>('input')?.focus()
  }

  private close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }))
  }

  private confirm() {
    if (this.typed === CONFIRM_WORD) this.dispatchEvent(new CustomEvent('confirm', { bubbles: true, composed: true }))
  }

  // Keys typed in the dialog must not reach the app's shortcuts (F5 copy, Del delete, ...).
  private onKeyDown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape') this.close()
    else if (e.key === 'Enter' && this.typed === CONFIRM_WORD) this.confirm()
  }

  render() {
    return html`
      <div
        class="backdrop"
        @click=${(e: Event) => e.target === e.currentTarget && this.close()}
        @keydown=${this.onKeyDown}
      >
        <div class="dialog" role="alertdialog" aria-label="Empty the iPod library">
          <header>
            <h3>Empty the iPod library</h3>
            <button @click=${this.close} title="Cancel (Esc)">✕</button>
          </header>
          <div class="body">
            <div class="danger">
              This deletes <strong>everything</strong> in the iPod's music library
              (${this.trackCount} track${this.trackCount === 1 ? '' : 's'}). It can't be undone.
            </div>

            <h4>What happens</h4>
            <ul>
              <li>Every track is removed from the iPod's database (<code>iTunesDB</code>), including all playlists' contents
                and their artwork entries</li>
              <li><strong>Every file</strong> in <code>iPod_Control/Music</code> is deleted, also files the database no longer knew
                about (e.g. left over from an interrupted copy)</li>
              <li>Afterwards the iPod shows an empty library, ready to be filled again</li>
            </ul>

            <h4>What is not touched</h4>
            <ul>
              <li>The iPod's firmware and settings, photos, games, notes and other files</li>
              <li>Your music on this computer</li>
            </ul>

            <h4>Before you continue</h4>
            <ul>
              <li><code>iTunesDB</code> is backed up as <code>iTunesDB.previous.bak</code>, but the deleted audio files
                cannot be brought back - copy anything you want to keep to your computer first</li>
              <li>Keep the iPod connected and don't close the app until it has finished</li>
            </ul>

            <div class="confirm">
              <label for="word">Type <code>${CONFIRM_WORD}</code> to confirm:</label>
              <input
                id="word"
                autocomplete="off"
                spellcheck="false"
                .value=${this.typed}
                @input=${(e: Event) => (this.typed = (e.target as HTMLInputElement).value.trim())}
              />
            </div>
          </div>
          <footer>
            <button @click=${this.close}>Cancel</button>
            <button class="danger-button" ?disabled=${this.typed !== CONFIRM_WORD} @click=${this.confirm}>
              Delete everything
            </button>
          </footer>
        </div>
      </div>
    `
  }
}
