import { LitElement, html, css } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import type { TagsPreview } from './types'

/**
 * Shown before "Set tags from folders" really changes anything: explains the rules, lets the user
 * set the optional delimiters, and previews before/after tags of the first few files.
 * Fires "close", "confirm" and "options-change" ({ albumDelimiter, artistDelimiter }).
 */
@customElement('tags-dialog')
export class TagsDialog extends LitElement {
  @property({ attribute: false }) preview: TagsPreview | null = null
  @property() error = ''
  @property() albumDelimiter = ''
  @property() artistDelimiter = ''

  static styles = css`
    .backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: flex;
      align-items: center; justify-content: center; z-index: 10;
    }
    .dialog {
      background: #1b1b21; border: 1px solid #2a2a33; border-radius: 12px; width: min(680px, 94vw);
      max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0, 0, 0, .5);
      color: #e8e8ec; font-size: .82rem;
    }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #2a2a33; }
    header h3 { margin: 0; flex: 1; font-size: .95rem; }
    header button { background: none; border: none; color: #a0a0b0; cursor: pointer; font-size: 1.1rem; }
    header button:hover { color: #fff; }
    .body { padding: 12px 16px; overflow-y: auto; line-height: 1.45; }
    .warning {
      background: #3a2a1a; border: 1px solid #7a5a2a; color: #f3c98b; border-radius: 8px;
      padding: 8px 10px; margin-bottom: 12px;
    }
    h4 { margin: 14px 0 4px; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: #8a8a9a; }
    h4:first-of-type { margin-top: 0; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 2px 0; }
    li span { color: #8a8a9a; }
    code { background: #26262e; border-radius: 4px; padding: 0 4px; }
    .options { display: grid; grid-template-columns: max-content 5em 1fr; gap: 6px 10px; align-items: center; }
    .options input {
      background: #1f1f27; border: 1px solid #2a2a33; color: #e8e8ec; border-radius: 6px;
      padding: 3px 6px; font: inherit; outline: none;
    }
    .options input:focus { border-color: #7c3aed; }
    .options .desc { color: #8a8a9a; }
    .example { border: 1px solid #2a2a33; border-radius: 8px; padding: 6px 10px; margin: 6px 0; }
    .example .file { color: #cbd5f5; margin-bottom: 2px; word-break: break-all; }
    .example dl { display: grid; grid-template-columns: max-content 1fr; gap: 1px 12px; margin: 0; }
    .example dt { color: #6d6d80; }
    .example dd { margin: 0; word-break: break-word; }
    .old { color: #8a8a9a; text-decoration: line-through; }
    .new { color: #a7f3d0; }
    .same { color: #8a8a9a; }
    .note { color: #8a8a9a; margin-top: 6px; }
    .skipped { color: #f3c98b; margin-top: 6px; }
    .error { color: #f77; }
    .empty { color: #6d6d80; }
    footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid #2a2a33; }
    footer button {
      background: #26262e; border: 1px solid #2a2a33; color: #e8e8ec; cursor: pointer;
      font: inherit; padding: 5px 14px; border-radius: 6px;
    }
    footer button:hover:not(:disabled) { border-color: #7c3aed; }
    footer button.primary { background: #5b2fc0; border-color: #7c3aed; }
    footer button:disabled { opacity: .45; cursor: default; }
  `

  private close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }))
  }

  private confirm() {
    this.dispatchEvent(new CustomEvent('confirm', { bubbles: true, composed: true }))
  }

  private optionsChanged() {
    const value = (name: string) => this.renderRoot.querySelector<HTMLInputElement>(`input[name=${name}]`)?.value ?? ''
    this.dispatchEvent(
      new CustomEvent('options-change', {
        detail: { albumDelimiter: value('album'), artistDelimiter: value('artist') },
        bubbles: true,
        composed: true,
      }),
    )
  }

  /** One before -> after line; unchanged values are shown once, greyed out. */
  private change(before: string | null, after: string) {
    return before === after
      ? html`<span class="same">${after} (unchanged)</span>`
      : html`<span class="old">${before ?? '(empty)'}</span> → <span class="new">${after}</span>`
  }

  private renderExamples(preview: TagsPreview) {
    if (preview.examples.length === 0) return html`<div class="empty">No files to change.</div>`
    return html`
      ${preview.examples.map((ex) => {
        const after = ex.after!
        const cover = ex.cover
          ? html`<span class="new">${ex.cover} embedded as 256×256</span>`
          : ex.before.hasCover
            ? html`<span class="same">no image in the folder - existing cover kept</span>`
            : html`<span class="same">none (no image in the folder)</span>`
        return html`
          <div class="example">
            <div class="file">${ex.folder}/${ex.fileName}</div>
            <dl>
              <dt>Title</dt><dd>${this.change(ex.before.title, after.title)}</dd>
              <dt>Album</dt><dd>${this.change(ex.before.album, after.album)}</dd>
              <dt>Artist</dt><dd>${this.change(ex.before.artist, after.artist)}</dd>
              <dt>Cover</dt><dd>${cover}</dd>
            </dl>
          </div>
        `
      })}
      ${preview.total - preview.skipped > preview.examples.length
        ? html`<div class="note">… and ${preview.total - preview.skipped - preview.examples.length} more files.</div>`
        : ''}
    `
  }

  render() {
    const p = this.preview
    const toChange = p ? p.total - p.skipped : 0
    return html`
      <div class="backdrop" @click=${(e: Event) => e.target === e.currentTarget && this.close()}>
        <div class="dialog" role="dialog" aria-label="Set tags from folders">
          <header>
            <h3>Set tags from folders</h3>
            <button @click=${this.close} title="Cancel (Esc)">✕</button>
          </header>
          <div class="body">
            <div class="warning">
              This rewrites the ID3 tags <strong>directly in the original mp3 files</strong> of your selection
              (folders include everything inside them). It can't be undone - work on a copy if unsure.
            </div>

            <h4>What happens to every mp3</h4>
            <ul>
              <li><strong>Title</strong> = file name without <code>.mp3</code>
                <span>- <code>1-hello</code> becomes <code>01-hello</code>, <code>… Track 1</code> becomes <code>… Track 01</code>, so the iPod sorts them correctly</span></li>
              <li><strong>Album</strong> = name of the folder the file is in</li>
              <li><strong>Artist</strong> = name of that folder's parent folder
                <span>(files must be sorted as <code>artist/album/file.mp3</code>, others are skipped)</span></li>
              <li>An old <strong>ID3v1</strong> tag is removed (it can confuse the iPod)</li>
              <li>The folder's <code>Folder.jpg</code> (else its last .jpg) is embedded as <strong>256×256 cover</strong>;
                without an image the existing cover stays</li>
              <li>Year, genre, track number etc. and the file names are <strong>not</strong> touched</li>
            </ul>

            <h4>Optional</h4>
            <div class="options">
              <label for="album">Album delimiter</label>
              <input id="album" name="album" .value=${this.albumDelimiter} @change=${this.optionsChanged} />
              <span class="desc">e.g. <code>-</code>: title <code>CD1-Track 01</code> in album "X" gives album "X CD01"</span>
              <label for="artist">Artist delimiter</label>
              <input id="artist" name="artist" .value=${this.artistDelimiter} @change=${this.optionsChanged} />
              <span class="desc">e.g. <code>-</code>: title <code>Abba-Waterloo</code> gives artist "Abba"</span>
            </div>

            <h4>Preview</h4>
            ${this.error
              ? html`<div class="error">${this.error}</div>`
              : p
                ? html`
                    <div>${toChange} of ${p.total} mp3 files will be changed.</div>
                    ${p.skipped > 0
                      ? html`<div class="skipped">${p.skipped} will be skipped: not inside an artist/album folder.</div>`
                      : ''}
                    ${this.renderExamples(p)}
                  `
                : html`<div class="empty">Loading…</div>`}
          </div>
          <footer>
            <button @click=${this.close}>Cancel</button>
            <button class="primary" ?disabled=${!p || toChange === 0} @click=${this.confirm}>
              ${p && toChange > 0 ? `Rewrite ${toChange} file${toChange === 1 ? '' : 's'}` : 'Rewrite'}
            </button>
          </footer>
        </div>
      </div>
    `
  }
}
