import { LitElement, html, css } from 'lit'
import { customElement } from 'lit/decorators.js'
import './local-pane'
import './ipod-pane'

@customElement('wizard-app')
export class WizardApp extends LitElement {
  static styles = css`
    :host {
      display: grid; grid-template-columns: 1fr 1fr; height: 100%;
      font-family: 'Inter', -apple-system, sans-serif; background: #0f0f11; color: #e8e8ec;
      box-sizing: border-box; overflow: hidden;
    }
  `

  render() {
    return html`
      <local-pane></local-pane>
      <ipod-pane></ipod-pane>
    `
  }
}
