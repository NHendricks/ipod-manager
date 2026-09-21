import { LitElement, html, css } from 'lit'
import { customElement } from 'lit/decorators.js'

/**
 * Help for restoring the iPod's firmware from an Apple firmware image (.ipsw). The app can't do
 * this itself - it only talks to the iPod's music database via libgpod - so this explains why and
 * walks through Apple's own restore. Fires "close".
 */
@customElement('firmware-dialog')
export class FirmwareDialog extends LitElement {
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
    h4 { margin: 14px 0 4px; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: #8a8a9a; }
    h4:first-of-type { margin-top: 0; }
    ul, ol { margin: 0; padding-left: 20px; }
    li { margin: 3px 0; }
    li span { color: #8a8a9a; }
    code { background: #26262e; border-radius: 4px; padding: 0 4px; }
    footer { display: flex; justify-content: flex-end; padding: 10px 16px; border-top: 1px solid #2a2a33; }
    footer button {
      background: #26262e; border: 1px solid #2a2a33; color: #e8e8ec; cursor: pointer;
      font: inherit; padding: 5px 14px; border-radius: 6px;
    }
    footer button:hover { border-color: #7c3aed; }
  `

  firstUpdated() {
    this.renderRoot.querySelector<HTMLButtonElement>('footer button')?.focus()
  }

  private close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }))
  }

  // Keys typed in the dialog must not reach the app's shortcuts (F5 copy, Del delete, ...).
  private onKeyDown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape') this.close()
  }

  render() {
    return html`
      <div
        class="backdrop"
        @click=${(e: Event) => e.target === e.currentTarget && this.close()}
        @keydown=${this.onKeyDown}
      >
        <div class="dialog" role="dialog" aria-label="Restore the iPod firmware">
          <header>
            <h3>Restore the iPod's firmware</h3>
            <button @click=${this.close} title="Close (Esc)">✕</button>
          </header>
          <div class="body">
            <div class="notice">
              This app <strong>can't</strong> restore firmware. It only manages the music on the iPod (via libgpod);
              installing an Apple firmware image (<code>.ipsw</code>) needs Apple's own restore tool, and doing it with
              anything else can leave the iPod unusable. Here is how to do it with Apple's tool.
            </div>

            <h4>Do you need this?</h4>
            <ul>
              <li>The iPod doesn't start, hangs on the Apple logo, shows a folder with an exclamation mark or a
                "connect to iTunes" screen, or isn't recognised at all</li>
              <li>If only the <em>music</em> is broken, the milder <strong>Empty library…</strong> button is enough -
                it keeps the firmware and settings</li>
            </ul>

            <h4>Restore with Apple's tool</h4>
            <ol>
              <li><strong>Reset</strong> the iPod: slide the Hold switch on and off, then hold <code>Menu</code> +
                <code>Select</code> (centre) for about 8 seconds until the Apple logo appears</li>
              <li><strong>Disk mode</strong>: as soon as the logo appears, hold <code>Select</code> +
                <code>Play/Pause</code> until the disk-mode screen shows</li>
              <li>Connect it to the PC and open <strong>iTunes for Windows</strong>
                <span>(the newer "Apple Devices" app may not support the iPod Classic)</span></li>
              <li>iTunes offers to <strong>Restore iPod</strong>. It downloads the firmware itself; to use a firmware
                file you already have, hold <code>Shift</code> while clicking Restore and pick the <code>.ipsw</code>
                <span>(this usually works for iPods, but depends on your iTunes version)</span></li>
              <li>Wait until it has finished and don't disconnect. <strong>Everything on the iPod is erased</strong>:
                the firmware is reinstalled and the disk reformatted</li>
            </ol>

            <h4>Afterwards</h4>
            <ul>
              <li>Restoring with iTunes for Windows formats the iPod for Windows, so it appears as a drive letter and
                this app sees it again. (An iPod formatted on a Mac won't show up as a drive in Windows)</li>
              <li>The library is empty - copy your music back with F5 or drag &amp; drop</li>
              <li>Copy anything you want to keep to your computer <em>before</em> restoring</li>
            </ul>
          </div>
          <footer>
            <button @click=${this.close}>Close</button>
          </footer>
        </div>
      </div>
    `
  }
}
