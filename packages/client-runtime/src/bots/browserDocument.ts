import type { BotBrowserPage } from "@t3tools/contracts";

/** Render the live DOM as a view; page scripts continue to run only in Lightpanda. */
export function buildBotBrowserDocument(page: BotBrowserPage): string {
  const doc = new DOMParser().parseFromString(page.html, "text/html");
  for (const node of doc.querySelectorAll(
    "script,noscript,iframe,frame,frameset,object,embed,base,meta",
  ))
    node.remove();
  for (const node of doc.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) {
      if (
        /^on/i.test(attr.name) ||
        ["srcdoc", "autofocus", "formaction", "nonce"].includes(attr.name)
      )
        node.removeAttribute(attr.name);
    }
    if (node.tagName === "LINK" && node.getAttribute("rel")?.toLowerCase() !== "stylesheet")
      node.remove();
  }
  const baseUrl = page.url === "about:blank" ? null : new URL(page.url);
  if (
    baseUrl &&
    (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password)
  )
    throw new Error("This page cannot be displayed.");
  const nonce = `j1${page.revision.replace(/[^a-zA-Z0-9]/g, "")}`;
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https: http:; img-src data: https: http:; font-src data: https: http:; connect-src 'none'; form-action 'none'; base-uri ${baseUrl?.origin ?? "'none'"}`;
  doc.head.prepend(csp);
  if (baseUrl) {
    const base = doc.createElement("base");
    base.href = baseUrl.toString();
    doc.head.append(base);
  }
  const style = doc.createElement("style");
  style.textContent =
    "*{animation:none!important;transition:none!important}html{scroll-behavior:auto!important}";
  doc.head.append(style);
  const bridge = doc.createElement("script");
  bridge.setAttribute("nonce", nonce);
  bridge.textContent = `(() => {
    const revision = ${JSON.stringify(page.revision)};
    const send = action => {
      const message = {type:'j1-bot-browser',revision,action};
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
      else window.parent.postMessage(message,'*');
    };
    const edits = new Map(); let pending;
    const click = node => {
      clearTimeout(pending);
      const changed = Array.from(edits,([node,value])=>({node,value})); edits.clear();
      send({type:'click',revision,node:Number(node.getAttribute('data-j1-browser-node')),...(changed.length?{edits:changed}:{})});
    };
    document.addEventListener('click', event => {
      const node = event.target instanceof Element ? event.target.closest('[data-j1-browser-node]') : null;
      if (!node) return;
      if (node.matches('textarea,select,input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])')) return;
      event.preventDefault();
      click(node);
    },true);
    document.addEventListener('change', event => {
      const node=event.target;
      if (!(node instanceof Element) || !node.hasAttribute('data-j1-browser-node') || !node.matches('input,textarea,select') || node.matches('[type=checkbox],[type=radio],[type=file],[type=hidden]')) return;
      edits.set(Number(node.getAttribute('data-j1-browser-node')),node.value);
      clearTimeout(pending); pending=setTimeout(()=>{const changed=Array.from(edits,([node,value])=>({node,value}));edits.clear();const first=changed.shift();if(first)send({type:'fill',revision,...first,...(changed.length?{edits:changed}:{})});},150);
    },true);
    document.addEventListener('keydown',event=>{
      if(event.key!=='Enter' || !(event.target instanceof Element) || !event.target.matches('input') || !event.target.form)return;
      const submit=event.target.form.querySelector('button[type=submit],button:not([type]),input[type=submit]');
      if(submit && submit.hasAttribute('data-j1-browser-node')) {event.preventDefault();edits.set(Number(event.target.getAttribute('data-j1-browser-node')),event.target.value);click(submit);}
    },true);
    document.addEventListener('submit',event=>event.preventDefault(),true);
    for (const eventName of ['focusin','focusout']) document.addEventListener(eventName,event=>{
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({type:'j1-bot-browser-focus',revision,editing:eventName==='focusin' && event.target instanceof Element && event.target.matches('input,textarea,select')}));
    },true);
  })();`;
  doc.body.append(bridge);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
