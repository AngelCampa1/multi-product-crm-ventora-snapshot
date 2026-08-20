export function mountWidget(shadowRoot: ShadowRoot, html: string, css: string): void {
  shadowRoot.innerHTML = `<style>${css}</style>${html}`;
}

export function createShadowHost(beforeScript: HTMLOrSVGScriptElement): ShadowRoot {
  const host = document.createElement("div");
  beforeScript.parentNode?.insertBefore(host, beforeScript);
  return host.attachShadow({ mode: "open" });
}
