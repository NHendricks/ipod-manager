import { LitElement, html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import type { FileMetadata } from './types'

@customElement('metadata-dialog')
export class MetadataDialog extends LitElement {
  @property({ attribute: false }) metadata: FileMetadata | null = null
  @property() error = ''

  static styles = css`
    .backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: flex;
      align-items: center; justify-content: center; z-index: 10;
    }
    .dialog {
      background: #1b1b21; border: 1px solid #2a2a33; border-radius: 12px; width: min(560px, 92vw);
      max-height: 86vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0, 0, 0, .5);
    }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #2a2a33; }
    header h3 { margin: 0; flex: 1; font-size: .95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header button { background: none; border: none; color: #a0a0b0; cursor: pointer; font-size: 1.1rem; }
    header button:hover { color: #fff; }
    .body { padding: 12px 16px; overflow-y: auto; }
    .cover { float: right; width: 120px; height: 120px; object-fit: cover; border-radius: 8px; margin: 0 0 8px 12px; }
    h4 { margin: 12px 0 4px; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: #8a8a9a; }
    h4:first-of-type { margin-top: 0; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 16px; margin: 0; font-size: .82rem; }
    dt { color: #6d6d80; }
    dd { margin: 0; color: #e8e8ec; word-break: break-word; }
    .hint { padding: 8px 16px; border-top: 1px solid #2a2a33; font-size: .72rem; color: #6d6d80; }
    .error { color: #f77; font-size: .85rem; }
    .empty { color: #6d6d80; font-size: .82rem; }
  `

  private close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }))
  }

  private rows(rows: [string, string][]) {
    return rows.length === 0
      ? html`<div class="empty">None</div>`
      : html`<dl>${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`
  }

  render() {
    const m = this.metadata
    return html`
      <div class="backdrop" @click=${(e: Event) => e.target === e.currentTarget && this.close()}>
        <div class="dialog" role="dialog" aria-label="Metadata">
          <header>
            <h3 title=${m?.path ?? ''}>${m?.fileName ?? 'Metadata'}</h3>
            <button @click=${this.close} title="Close (Esc)">✕</button>
          </header>
          <div class="body">
            ${this.error
              ? html`<div class="error">${this.error}</div>`
              : m
                ? html`
                    ${m.cover ? html`<img class="cover" src=${m.cover} alt="Cover" />` : ''}
                    <h4>Tags</h4>
                    ${this.rows(m.tags)}
                    <h4>Technical</h4>
                    ${this.rows(m.technical)}
                  `
                : html`<div class="empty">Loading…</div>`}
          </div>
          <div class="hint">F3 or Esc to close</div>
        </div>
      </div>
    `
  }
}
