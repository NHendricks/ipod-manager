import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'

const BACKEND = 'http://localhost:3001'

@customElement('wizard-app')
export class WizardApp extends LitElement {
  @state() private name = ''
  @state() private response = ''
  @state() private loading = false

  static styles = css`
    :host {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 16px; height: 100%; font-family: 'Inter', sans-serif;
      background: #0f0f11; color: #e8e8ec; box-sizing: border-box;
    }
    h1 { font-size: 1.4rem; font-weight: 600; margin: 0; }
    .row { display: flex; gap: 8px; }
    input {
      background: #26262e; border: 1px solid #3a3a46; color: #e8e8ec;
      border-radius: 8px; padding: 8px 12px; font-size: .9rem; outline: none;
    }
    input:focus { border-color: #7c3aed; }
    button {
      background: #7c3aed; border: none; border-radius: 8px; color: #fff;
      padding: 8px 16px; font-size: .9rem; font-weight: 600; cursor: pointer;
    }
    button:hover:not(:disabled) { background: #6d28d9; }
    button:disabled { background: #3a3a46; color: #6d6d80; cursor: not-allowed; }
    .response { font-size: .9rem; color: #a78bfa; min-height: 1.2em; }
  `

  private async sayHello() {
    this.loading = true
    try {
      const res = await fetch(`${BACKEND}/api/hello`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.name }),
      })
      const data = await res.json()
      this.response = data.message ?? ''
    } catch {
      this.response = 'Backend nicht erreichbar'
    } finally {
      this.loading = false
    }
  }

  render() {
    return html`
      <h1>Hello, Wizard!</h1>
      <div class="row">
        <input
          type="text"
          placeholder="Your name"
          .value=${this.name}
          @input=${(e: Event) => { this.name = (e.target as HTMLInputElement).value }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.sayHello() }}
        />
        <button ?disabled=${this.loading} @click=${this.sayHello}>Say hello</button>
      </div>
      <div class="response">${this.response}</div>
    `
  }
}
